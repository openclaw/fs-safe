import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSame, balancedOrder, compilerEnvironment, inventory, officialCompiler, qualify, runProcess,
} from "./compiler-qualification.mjs";
import { resolveNpmCli } from "./npm-cli.mjs";

const script = fileURLToPath(import.meta.url);
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export function cleanHelperOutputs(root) {
  // Only disposable CI checkouts call this. Keep sources, staged helper and
  // dependency download caches; a fresh Cargo target owns Rust output separately.
  for (const name of ["bin", "obj"]) {
    fs.rmSync(path.join(root, "native/windows-security-helper", name), { recursive: true, force: true });
  }
}

export function redact(value, locations) {
  if (typeof value === "string") {
    for (const [location, label] of [...locations].sort((a, b) => b[0].length - a[0].length)) {
      for (const spelling of [location, location.replaceAll("\\", "/")]) {
        value = value.replace(new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), label);
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, locations));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, locations)]));
  }
  return value;
}

export function preservePackage(root, check) {
  const before = inventory(path.join(root, "dist"));
  check();
  assertSame(inventory(path.join(root, "dist")), before, "package output before and after proof");
  return before;
}

function campaign() {
  // Full builds spawn Cargo/.NET descendants. The isolated Actions job owns the
  // entire process tree and its deadline; never run this destructive experiment
  // in an operator checkout or pretend a parent-only timeout stopped its children.
  const root = fs.realpathSync(path.resolve(import.meta.dirname, ".."));
  if (process.env.GITHUB_ACTIONS !== "true" ||
      fs.realpathSync(process.env.GITHUB_WORKSPACE ?? ".") !== root ||
      !process.env.RUNNER_TEMP || !process.env.GITHUB_OUTPUT) {
    throw new Error("platform qualification requires its disposable GitHub Actions checkout");
  }
  const output = fs.mkdtempSync(path.join(fs.realpathSync(process.env.RUNNER_TEMP), "compiler-platform-"));
  const reports = path.join(output, "reports");
  fs.mkdirSync(reports);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `reports=${reports}\n`);
  const locations = [[root, "<repo>"], [output, "<campaign>"],
    [fs.realpathSync(process.env.RUNNER_TEMP), "<runner-temp>"], [os.homedir(), "<home>"]];
  const report = {
    schemaVersion: 1, status: "running", sourceCommit: null,
    host: { platform: process.platform, arch: process.arch, release: os.release(),
      node: process.version, cpu: os.cpus()[0]?.model, availableParallelism: os.availableParallelism() },
    measurement: { metric: "wall time", cpuTime: "not measured", peakRss: "not measured",
      cache: "OS and dependency caches uncontrolled; dependencies installed",
      warm: "dist recreated; Rust and .NET outputs retained",
      clean: "dist recreated; fresh Cargo target; .NET bin/obj removed before each sample",
      invocation: "both arms use explicit native compiler through prepack owner",
      deadline: "isolated Actions job timeout; no parent-only build timeout",
      warmupsPerArm: 2, warmRunsPerArm: 10, cleanRunsPerArm: 6 },
    processes: [], samples: [], packageProof: [],
  };
  const { env } = compilerEnvironment();
  function save(name, data) {
    const text = JSON.stringify(redact(data, locations), null, 2) + "\n";
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("report exceeds 4 MiB");
    fs.writeFileSync(path.join(reports, name + ".json"), text, { flag: "wx" });
  }
  function run(executable, args, label, extraEnv = env) {
    // No per-parent deadline: Actions cancels the complete job at 45 minutes.
    const result = runProcess(executable, args, { cwd: root, env: extraEnv, timeout: 0 });
    report.processes.push({ label, status: result.status, wallMs: result.wallMs });
    if (result.status !== 0) {
      throw new Error(`${label} failed (${result.status}): ${(result.stdout + result.stderr).slice(-8192)}`);
    }
    return result;
  }
  try {
    report.sourceCommit = run("git", ["rev-parse", "HEAD"], "source").stdout.trim();
    const prefix = path.join(output, "compiler");
    fs.mkdirSync(prefix);
    fs.writeFileSync(path.join(prefix, "package.json"), '{"private":true}\n');
    run(process.execPath, [resolveNpmCli(), "install", "--prefix", prefix, "--ignore-scripts",
      "--no-audit", "--no-fund", "--save-exact", "tsc-ts@0.0.2"], "candidate-install");
    const manifest = path.join(prefix, "node_modules/tsc-ts/package.json");
    const pkg = json(manifest);
    const platform = { darwin: `darwin-${process.arch}`, linux: `linux-${process.arch}-gnu`,
      win32: "win32-x64-msvc" }[process.platform];
    if (!platform || (process.platform === "win32" && process.arch !== "x64")) throw new Error("unsupported runner");
    const name = `@tsc-ts/${platform}`;
    const platformManifest = createRequire(manifest).resolve(`${name}/package.json`);
    const platformPkg = json(platformManifest);
    if (pkg.version !== "0.0.2" || platformPkg.version !== pkg.version || platformPkg.name !== name) {
      throw new Error("candidate package identity mismatch");
    }
    const candidate = fs.realpathSync(path.join(path.dirname(platformManifest), "lib",
      process.platform === "win32" ? "tsc-ts.exe" : "tsc-ts"));
    const lock = json(path.join(prefix, "package-lock.json"));
    report.candidate = { name: pkg.name, version: pkg.version, platform: name, executableSha256: digest(candidate),
      packages: Object.fromEntries(["tsc-ts", name].map((id) => {
        const item = lock.packages[`node_modules/${id}`];
        if (item?.version !== "0.0.2" || !item.integrity?.startsWith("sha512-") ||
            !item.resolved?.startsWith("https://registry.npmjs.org/")) throw new Error("missing npm provenance");
        return [id, { version: item.version, resolved: item.resolved, integrity: item.integrity }];
      })) };
    const official = officialCompiler(root);
    locations.push([official.library, "<typescript-lib>"]);
    const binaries = { official: official.executable, candidate };
    const buildEnv = { ...env, TSC_TS_LIB_DIR: official.library, CARGO_TARGET_DIR: path.join(output, "warm-target") };
    report.toolchains = {};
    for (const tool of ["rustc", "cargo", "dotnet"]) {
      report.toolchains[tool] = run(tool, ["--version"], tool).stdout.trim();
    }
    for (const tool of ["CC_wasm32_unknown_unknown", "AR_wasm32_unknown_unknown"]) {
      const key = Object.keys(env).find((key) => key.toUpperCase() === tool.toUpperCase());
      if (!key || !fs.existsSync(env[key])) throw new Error(`missing pinned ${tool}`);
      report.toolchains[tool] = { version: run(env[key], ["--version"], tool).stdout.trim(), sha256: digest(env[key]) };
    }
    report.toolchains.pnpm = json(path.join(root, "package.json")).packageManager;
    // Bootstrap the ignored staged helper before freezing source identity.
    run(process.execPath, ["scripts/build-windows-helper.mjs"], "helper-bootstrap");
    const tracked = run("git", ["ls-files", "-z"], "tracked-inputs").stdout.split("\0").filter(Boolean);
    function identity() {
      return { tracked: Object.fromEntries(tracked.map((file) => [file, digest(path.join(root, file))])),
        source: inventory(path.join(root, "src")), library: inventory(official.library),
        official: digest(official.executable), candidate: digest(candidate),
        candidateManifest: digest(manifest), platformManifest: digest(platformManifest) };
    }
    report.identity = identity();
    // Check the actual npm launcher with its own bundled libraries separately
    // from parity, which intentionally supplies the official library directory.
    const smoke = path.join(output, "launcher-smoke");
    fs.mkdirSync(smoke);
    fs.writeFileSync(path.join(smoke, "entry.ts"), 'export const values: Array<string> = ["ok"];\n');
    fs.writeFileSync(path.join(smoke, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], lib: ["ES2022"] }, files: ["entry.ts"],
    }));
    run(process.execPath, [path.resolve(path.dirname(manifest), pkg.bin["tsc-ts"]),
      "-p", path.join(smoke, "tsconfig.json"), "--pretty", "false"], "launcher-default-libraries");
    for (const singleThreaded of [false, true]) {
      const label = singleThreaded ? "single-threaded" : "default";
      const result = qualify({ root, candidate, output: path.join(output, label), singleThreaded });
      save(label, result);
      if (result.status !== "pass") throw new Error(`${label} compiler parity failed: ${result.failure}`);
    }
    let artifacts;
    function build(arm, mode, phase) {
      const sampleEnv = { ...buildEnv };
      let target;
      if (mode === "clean") {
        cleanHelperOutputs(root);
        target = fs.mkdtempSync(path.join(output, "clean-target-"));
        sampleEnv.CARGO_TARGET_DIR = target;
      }
      const result = run(process.execPath, ["scripts/prepack-build.mjs", "--compiler", binaries[arm],
        "--require-toolchains"], `${mode}-${phase}-${arm}`, sampleEnv);
      const files = inventory(path.join(root, "dist"));
      if (!files["archive-parser.wasm"] || !files["windows-security-helper.exe"] ||
          !Object.keys(files).some((name) => name.endsWith(".d.ts"))) throw new Error("incomplete build");
      if (artifacts) assertSame(files, artifacts, "complete build artifacts");
      else artifacts = files;
      assertSame(identity(), report.identity, "whole-build inputs");
      if (target) fs.rmSync(target, { recursive: true });
      return result;
    }
    build("official", "warm", "bootstrap");
    for (const mode of ["warm", "clean"]) {
      for (const [phase, count] of [["warmup", 2], ["measured", mode === "warm" ? 10 : 6]]) {
        for (const arm of balancedOrder(count)) {
          const result = build(arm, mode, phase);
          report.samples.push({ mode, phase, arm, wallMs: result.wallMs });
        }
      }
      // Pack once per arm and cache mode, outside timing. No command may rebuild
      // dist between the selected build and these installed-package checks.
      for (const arm of Object.keys(binaries)) {
        build(arm, mode, "package");
        const files = preservePackage(root, () => run(process.execPath,
          ["scripts/check-pack.mjs", "--candidate-compiler", candidate], `${mode}-${arm}-package`, buildEnv));
        report.packageProof.push({ mode, arm, status: "pass", files: Object.keys(files).length });
      }
    }
    report.artifacts = artifacts;
    assertSame(identity(), report.identity, "final campaign inputs");
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.failure = error.message;
    process.exitCode = 1;
  }
  save("build", report);
  console.log(JSON.stringify({ status: report.status, failure: redact(report.failure, locations),
    samples: report.samples.length }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) campaign();
