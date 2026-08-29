import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostNativeTarget, nativePackageDirectory, nativeTargets } from "./native-targets.mjs";
import { normalizePackResult } from "./npm-pack-result.mjs";

const outputIndex = process.argv.indexOf("--output");
const outputDir = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : "release-artifacts");
const allowHostOnly = process.argv.includes("--allow-host-only");
mkdirSync(outputDir, { recursive: true });
const npmCli = resolveNpmCli();
const npmEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
);

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  if (process.platform !== "win32") {
    try {
      candidates.push(realpathSync(execFileSync("which", ["npm"], { encoding: "utf8" }).trim()));
    } catch {
      // The standard bundled paths remain valid on supported non-Windows installations.
    }
  }
  const resolved = candidates.find(
    (candidate) => candidate && basename(candidate) === "npm-cli.js" && existsSync(candidate),
  );
  if (!resolved) throw new Error("could not resolve npm-cli.js from the current Node installation");
  return resolved;
}

function runNpm(args, options) {
  return execFileSync(process.execPath, [npmCli, ...args], { ...options, env: npmEnv });
}

function readPackage(directory = ".") {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function packPackage(directory, expectedName) {
  const output = runNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", outputDir],
    { cwd: directory, encoding: "utf8" },
  );
  const parsed = JSON.parse(output);
  const normalized = normalizePackResult(parsed, expectedName);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed[expectedName];
  const artifact = { ...entry, ...normalized };
  if (!artifact.filename || !artifact.integrity) {
    throw new Error(`npm pack returned incomplete metadata for ${expectedName}`);
  }
  return artifact;
}

function manifestEntry(pkg, artifact) {
  return {
    name: pkg.name,
    version: pkg.version,
    filename: artifact.filename,
    integrity: artifact.integrity,
    size: artifact.size,
    unpackedSize: artifact.unpackedSize,
  };
}

const rootPkg = readPackage();
if (rootPkg.name !== "@openclaw/fs-safe") throw new Error(`unexpected package name ${rootPkg.name}`);
if (rootPkg.author !== "OpenClaw Team <dev@openclaw.ai>") {
  throw new Error("root package has unexpected author metadata");
}
if (rootPkg.publishConfig?.access !== "public" || rootPkg.publishConfig?.provenance !== true) {
  throw new Error("root package must publish publicly with provenance");
}

const targets = allowHostOnly ? [hostNativeTarget()].filter(Boolean) : nativeTargets;
if (targets.length === 0) throw new Error(`no native target for ${process.platform}-${process.arch}`);

const manifest = [];
for (const target of targets) {
  const directory = fileURLToPath(nativePackageDirectory(target));
  const pkg = readPackage(directory);
  const binary = join(directory, "fs-safe-native.node");
  if (!existsSync(binary) || statSync(binary).size === 0) {
    throw new Error(`missing or empty native package binary ${binary}`);
  }
  if (
    pkg.name !== target.package ||
    pkg.version !== rootPkg.version ||
    pkg.main !== "fs-safe-native.node" ||
    pkg.os?.[0] !== target.os ||
    pkg.cpu?.[0] !== target.cpu ||
    (target.libc && pkg.libc?.[0] !== target.libc) ||
    pkg.publishConfig?.access !== "public" ||
    pkg.publishConfig?.provenance !== true
  ) {
    throw new Error(`${target.package} metadata does not match its native target`);
  }
  if (rootPkg.optionalDependencies?.[target.package] !== rootPkg.version) {
    throw new Error(`root package must pin ${target.package}@${rootPkg.version}`);
  }
  const artifact = packPackage(directory, pkg.name);
  const paths = new Set(artifact.files.map((file) => file.path));
  if (!paths.has("fs-safe-native.node") || !paths.has("package.json") || paths.size !== 2) {
    throw new Error(`${pkg.name} must contain only package.json and fs-safe-native.node`);
  }
  manifest.push(manifestEntry(pkg, artifact));
}

const rootArtifact = packPackage(process.cwd(), rootPkg.name);
const rootPaths = new Set(rootArtifact.files.map((file) => file.path));
for (const expected of ["dist/index.js", "dist/index.d.ts", "package.json"]) {
  if (!rootPaths.has(expected)) throw new Error(`packed root package is missing ${expected}`);
}
if ([...rootPaths].some((path) => path.endsWith(".node"))) {
  throw new Error("packed root package must not contain native binaries");
}
manifest.push(manifestEntry(rootPkg, rootArtifact));
writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const host = hostNativeTarget();
if (!host || !targets.some((target) => target.label === host.label)) {
  throw new Error(`release smoke requires the host target ${host?.label ?? "unknown"}`);
}
const hostArtifact = manifest.find((entry) => entry.name === host.package);
const smoke = mkdtempSync(join(tmpdir(), "fs-safe-release-smoke-"));
try {
  writeFileSync(join(smoke, "package.json"), '{"private":true,"type":"module"}\n');
  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      join(outputDir, rootArtifact.filename),
      join(outputDir, hostArtifact.filename),
    ],
    { cwd: smoke, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", "await import('@openclaw/fs-safe'); await import('@openclaw/fs-safe/config');"],
    { cwd: smoke, stdio: "pipe" },
  );

  const fixture = join(smoke, "fixture.txt");
  writeFileSync(fixture, "abc");
  const hashScript =
    "import {configureFsSafeNative} from '@openclaw/fs-safe';" +
    "import {sha256File} from '@openclaw/fs-safe/durability';" +
    "configureFsSafeNative({mode:'require'});" +
    `const result=await sha256File(${JSON.stringify(fixture)});` +
    "if(result.digest!=='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')throw new Error('native hash mismatch');" +
    "console.log(JSON.stringify(result));";
  const nativeProof = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", hashScript],
    { cwd: smoke, encoding: "utf8" },
  ).trim();

  const installedBinary = join(smoke, "node_modules", ...host.package.split("/"), "fs-safe-native.node");
  renameSync(installedBinary, `${installedBinary}.removed`);
  const fallbackProof = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      hashScript.replace("mode:'require'", "mode:'auto'").replace("native hash mismatch", "fallback hash mismatch"),
    ],
    { cwd: smoke, encoding: "utf8" },
  ).trim();
  const requiredProof = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import {configureFsSafeNative} from '@openclaw/fs-safe';" +
        "import {sha256File} from '@openclaw/fs-safe/durability';" +
        "configureFsSafeNative({mode:'require'});" +
        `try{await sha256File(${JSON.stringify(fixture)});throw new Error('native binding unexpectedly loaded')}` +
        "catch(error){if(error.code!=='helper-unavailable')throw error;console.log(error.code)}",
    ],
    { cwd: smoke, encoding: "utf8" },
  ).trim();
  console.log(`native binding: ${nativeProof}`);
  console.log(`auto fallback without platform package binary: ${fallbackProof}`);
  console.log(`required mode without platform package binary: ${requiredProof}`);
} finally {
  rmSync(smoke, { recursive: true, force: true });
}

for (const artifact of manifest) {
  console.log(`${artifact.name}: ${artifact.size} bytes gzipped, ${artifact.unpackedSize} bytes unpacked`);
}
