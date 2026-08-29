import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostNativeTarget, nativePackageDirectory, nativeTargets } from "./native-targets.mjs";
import { normalizePackResult } from "./npm-pack-result.mjs";
import { consumerInstallSmoke, isolatedConsumerEnv, resolvePnpmCli } from "./consumer-install-smoke.mjs";

const pnpmCli = resolvePnpmCli();
const outputIndex = process.argv.indexOf("--output");
const outputDir = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : "release-artifacts");
const allowHostOnly = process.argv.includes("--allow-host-only");
mkdirSync(outputDir, { recursive: true });
const npmCli = resolveNpmCli();
const packingConfig = mkdtempSync(join(tmpdir(), "fs-safe-pack-config-"));
const npmEnv = isolatedConsumerEnv(packingConfig);

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
  return execFileSync(process.execPath, [npmCli, ...args], {
    ...options, env: npmEnv, timeout: 120_000, killSignal: "SIGKILL",
  });
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

async function main() {
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
  await consumerInstallSmoke({ rootPkg, manifest, outputDir, npmCli, pnpmCli, allowHostOnly });

  for (const artifact of manifest) {
    console.log(`${artifact.name}: ${artifact.size} bytes gzipped, ${artifact.unpackedSize} bytes unpacked`);
  }
}

try {
  await main();
} finally {
  rmSync(packingConfig, { recursive: true, force: true });
}
