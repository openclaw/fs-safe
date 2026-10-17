import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const expectedOfficialVersion = "7.0.2";
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const portable = (value) => value.replaceAll(path.sep, "/");

export function assertSame(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} differ`);
}

export function runProcess(executable, args, options = {}) {
  const start = performance.now();
  const child = spawnSync(executable, args, {
    encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    ...options, shell: false, killSignal: "SIGKILL",
  });
  const result = {
    wallMs: performance.now() - start,
    status: child.status, signal: child.signal,
    error: child.error?.code ?? (child.error ? "spawn_error" : null),
    stdout: child.stdout ?? "", stderr: child.stderr ?? "",
  };
  if (result.error || result.signal || result.status === null) {
    throw Object.assign(new Error("compiler process did not complete"), { result });
  }
  return result;
}

export function inventory(directory) {
  const files = {};
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) files[portable(name)] = digest(path.join(directory, name));
      else throw new Error("unexpected non-regular artifact");
    }
  }
  visit("");
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export function balancedOrder(count) {
  if (!Number.isSafeInteger(count) || count < 2 || count % 2 !== 0) {
    throw new Error("sample counts must be positive even integers");
  }
  return Array.from({ length: count / 2 }, (_, i) =>
    i % 2 === 0 ? ["official", "candidate", "candidate", "official"]
      : ["candidate", "official", "official", "candidate"]).flat();
}

function beneath(file, directory) {
  const relative = path.relative(directory, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function inputInventory(text, root, library) {
  const result = {};
  const canonical = new Set();
  for (const line of text.trim().split(/\r?\n/)) {
    if (!line || !path.isAbsolute(line)) throw new Error("compiler returned an invalid input path");
    const file = fs.realpathSync(line);
    const name = beneath(file, library) ? `<typescript-lib>/${portable(path.relative(library, file))}`
      : beneath(file, root) ? portable(path.relative(root, file)) : null;
    if (!name) throw new Error("compiler input is outside the repository and pinned library");
    if (canonical.has(file) || Object.hasOwn(result, name)) throw new Error("duplicate compiler input");
    canonical.add(file);
    result[name] = digest(file);
  }
  if (!Object.keys(result).some((name) => name.startsWith("<typescript-lib>/"))) {
    throw new Error("compiler did not use the pinned library");
  }
  if (!Object.keys(result).some((name) => name.startsWith("src/"))) {
    throw new Error("compiler did not enumerate source inputs");
  }
  return result;
}

export function officialCompiler(root) {
  const manifest = createRequire(path.join(root, "package.json")).resolve("typescript/package.json");
  const pkg = readJson(manifest);
  const platformName = `@typescript/typescript-${process.platform}-${process.arch}`;
  const platformManifest = createRequire(manifest).resolve(`${platformName}/package.json`);
  const platformPkg = readJson(platformManifest);
  if (pkg.name !== "typescript" || pkg.version !== expectedOfficialVersion ||
      platformPkg.name !== platformName || platformPkg.version !== pkg.version) {
    throw new Error("official compiler packages do not match");
  }
  // TypeScript 7's native platform package owns both the executable and its libs.
  // Resolving from the parent package also works with pnpm's isolated dependencies.
  const library = fs.realpathSync(path.join(path.dirname(platformManifest), "lib"));
  fs.accessSync(path.join(library, "lib.d.ts"));
  return {
    executable: fs.realpathSync(path.join(library, process.platform === "win32" ? "tsc.exe" : "tsc")),
    library, manifest, platformManifest, version: pkg.version,
  };
}

function requireSuccess(result, label) {
  if (result.status !== 0 || result.stdout || result.stderr) throw new Error(`${label} was not clean`);
}

function diagnosticResult(result) {
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function requireEmitted(files) {
  if (!Object.keys(files).some((name) => name.endsWith(".js")) ||
      !Object.keys(files).some((name) => name.endsWith(".d.ts"))) {
    throw new Error("missing JavaScript or declaration output");
  }
}

export function qualify({ root = repository, candidate, output, runs = 10, warmup = 2, timeoutMs = 120_000, singleThreaded = false }) {
  const measuredOrder = balancedOrder(runs);
  const warmupOrder = balancedOrder(warmup);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid timeout");
  root = fs.realpathSync(root);
  candidate = fs.realpathSync(candidate);
  output = path.resolve(output);
  output = path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
  if (beneath(output, path.join(root, "src")) || beneath(output, path.join(root, "dist")) ||
      beneath(output, path.join(root, "node_modules"))) throw new Error("unsafe artifact destination");
  // Exclusive creation protects previous evidence and user files. Never clean an
  // existing directory: each campaign and each emit sample has its own custody.
  fs.mkdirSync(output);
  output = fs.realpathSync(output);
  const report = {
    schemaVersion: 1, status: "running", compilerVersion: null,
    host: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version,
      cpu: os.cpus()[0]?.model, availableParallelism: os.availableParallelism() },
    measurement: { wallClockOnly: true, cpuTime: "not measured", peakRss: "not measured",
      cache: "uncontrolled; fresh process per invocation", runs, warmup, singleThreaded, timeoutMs },
    scope: "CLI diagnostic start-location, source checking, and emitted-byte parity; no package or runtime qualification",
    processes: [], samples: [],
  };
  let normalize = (value) => value.replaceAll(output, "<artifacts>").replaceAll(root, "<repo>");
  try {
    const official = officialCompiler(root);
    report.compilerVersion = official.version;
    const locations = [[official.library, "<typescript-lib>"], [candidate, "<candidate>"],
      [output, "<artifacts>"], [root, "<repo>"]].sort((a, b) => b[0].length - a[0].length);
    normalize = (value) => {
      for (const [location, label] of locations) {
        value = value.replaceAll(location, label).replaceAll(portable(location), label);
      }
      return value.replaceAll("\r\n", "\n");
    };
    const env = { ...process.env };
    const cleared = Object.keys(env).filter((key) => key.startsWith("TSC_TS_") ||
      ["GOGC", "GOMEMLIMIT", "GOMAXPROCS", "GODEBUG"].includes(key)).sort();
    for (const key of cleared) delete env[key];
    env.TSC_TS_LIB_DIR = official.library;
    report.compilerEnvironment = { cleared, TSC_TS_LIB_DIR: "<typescript-lib>" };
    const binaries = { official: official.executable, candidate };
    const common = ["--pretty", "false", ...(singleThreaded ? ["--singleThreaded"] : [])];
    function invoke(arm, args, stage, raw = false) {
      try {
        const result = runProcess(binaries[arm], args, { cwd: root, env, timeout: timeoutMs });
        const display = { ...result, stdout: normalize(result.stdout), stderr: normalize(result.stderr) };
        report.processes.push({ arm, stage, args: args.map(normalize), ...display });
        return raw ? result : display;
      } catch (error) {
        if (error.result) report.processes.push({ arm, stage, args: args.map(normalize),
          ...error.result, stdout: normalize(error.result.stdout), stderr: normalize(error.result.stderr) });
        throw error;
      }
    }
    function fingerprint() {
      return {
        source: inventory(path.join(root, "src")),
        config: digest(path.join(root, "tsconfig.json")), lockfile: digest(path.join(root, "pnpm-lock.yaml")),
        package: digest(path.join(root, "package.json")), runner: digest(script),
        official: digest(official.executable), candidate: digest(candidate),
        officialManifest: digest(official.manifest), platformManifest: digest(official.platformManifest),
        library: inventory(official.library),
      };
    }
    report.identity = fingerprint();
    report.versions = Object.fromEntries(Object.keys(binaries).map((arm) => {
      const result = invoke(arm, ["--version"], "version");
      if (result.status !== 0 || result.stderr || !result.stdout.trim()) throw new Error("version probe failed");
      return [arm, result.stdout.trim()];
    }));
    assertSame(report.versions.official, `Version ${expectedOfficialVersion}`, "official executable version and pinned version");
    const project = ["-p", "tsconfig.json", ...common];
    const configs = Object.keys(binaries).map((arm) => {
      const result = invoke(arm, [...project, "--showConfig"], "config");
      if (result.status !== 0 || result.stderr) throw new Error("config probe failed");
      return JSON.parse(result.stdout);
    });
    assertSame(configs[0], configs[1], "effective configs");
    report.config = configs[0];
    const options = report.config.compilerOptions;
    if (options.outFile || options.declarationDir || options.incremental || options.composite ||
        options.tsBuildInfoFile || options.noEmit || options.emitDeclarationOnly || !options.declaration) {
      throw new Error("unsupported output routing or incremental config");
    }
    function inputs(arm) {
      // Enumeration needs raw paths for realpath/hash checks, not display labels.
      const result = invoke(arm, [...project, "--listFilesOnly"], "inputs", true);
      if (result.status !== 0 || result.stderr) throw new Error("input enumeration failed");
      return inputInventory(result.stdout, root, official.library);
    }
    report.inputs = inputs("official");
    assertSame(inputs("candidate"), report.inputs, "resolved inputs");
    for (const arm of Object.keys(binaries)) requireSuccess(invoke(arm, [...project, "--noEmit"], "check"), "source check");

    const fixture = path.join(output, "fixture");
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(path.join(fixture, "tsconfig.json"), JSON.stringify({
      compilerOptions: { ...options, types: [], noEmit: true, rootDir: ".", outDir: "unused" }, files: ["entry.ts"],
    }));
    const fixtureArgs = ["-p", path.join(fixture, "tsconfig.json"), ...common];
    for (const [kind, text] of [["valid", 'export const value: string = "ok";\n'],
      ["invalid", "export const value: string = 1;\n"]]) {
      fs.writeFileSync(path.join(fixture, "entry.ts"), text);
      const outcomes = Object.keys(binaries).map((arm) => invoke(arm, fixtureArgs, `fixture-${kind}`));
      assertSame(diagnosticResult(outcomes[0]), diagnosticResult(outcomes[1]), `${kind} diagnostics`);
      if (kind === "valid") requireSuccess(outcomes[0], "valid fixture");
      else if (outcomes[0].status === 0 || !/entry\.ts\(1,14\): error TS2322:/.test(outcomes[0].stdout)) {
        throw new Error("invalid fixture did not report the expected type error and start location");
      }
    }

    let emitted;
    function emit(arm, name, stage) {
      const directory = path.join(output, name);
      fs.mkdirSync(directory);
      const result = invoke(arm, [...project, "--outDir", directory], stage);
      requireSuccess(result, "emission");
      const files = inventory(directory);
      requireEmitted(files);
      if (emitted) assertSame(files, emitted, "emitted artifacts");
      else emitted = files;
      if (stage !== "emit-parity") fs.rmSync(directory, { recursive: true });
      return result;
    }
    for (const arm of Object.keys(binaries)) emit(arm, arm, "emit-parity");
    report.emitted = emitted;
    for (const mode of ["check", "emit"]) {
      for (const [phase, order] of [["warmup", warmupOrder], ["measured", measuredOrder]]) {
        for (const [index, arm] of order.entries()) {
          const stage = `${mode}-${phase}-${index}`;
          const result = mode === "emit" ? emit(arm, stage, stage)
            : invoke(arm, [...project, "--noEmit"], stage);
          requireSuccess(result, stage);
          report.samples.push({ mode, phase, arm, wallMs: result.wallMs });
        }
      }
    }
    for (const arm of Object.keys(binaries)) assertSame(inputs(arm), report.inputs, "final resolved inputs");
    for (const arm of Object.keys(binaries)) assertSame(inventory(path.join(output, arm)), emitted, "retained emitted artifacts");
    assertSame(fingerprint(), report.identity, "campaign identities before and after execution");
    report.status = "pass";
  } catch (error) {
    report.status = "fail";
    report.failure = normalize(error.message);
  }
  fs.writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    const { values } = parseArgs({ options: {
      candidate: { type: "string" }, output: { type: "string" }, runs: { type: "string", default: "10" },
      warmup: { type: "string", default: "2" }, "timeout-ms": { type: "string", default: "120000" },
      "single-threaded": { type: "boolean", default: false },
    } });
    if (!values.candidate || !values.output) throw new Error("required: --candidate <native executable> --output <new directory>");
    const report = qualify({ candidate: values.candidate, output: values.output, runs: Number(values.runs),
      warmup: Number(values.warmup), timeoutMs: Number(values["timeout-ms"]), singleThreaded: values["single-threaded"] });
    process.stdout.write(`${JSON.stringify({ status: report.status, failure: report.failure, samples: report.samples.length })}\n`);
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`compiler qualification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
