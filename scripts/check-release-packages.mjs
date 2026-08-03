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
import { hostNativeTarget, nativeTargets } from "./native-targets.mjs";

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
  return execFileSync(process.execPath, [npmCli, ...args], {
    ...options,
    env: npmEnv,
  });
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.name !== "@openclaw/fs-safe") throw new Error(`unexpected package name ${pkg.name}`);
if (pkg.author !== "OpenClaw Team <dev@openclaw.ai>") {
  throw new Error("root package has unexpected author metadata");
}
if (pkg.publishConfig?.access !== "public" || pkg.publishConfig?.provenance !== true) {
  throw new Error("root package must publish publicly with provenance");
}
if (pkg.optionalDependencies?.["@openclaw/fs-safe-native"]) {
  throw new Error("root package must not depend on the retired native loader package");
}

const expectedTargets = allowHostOnly ? [hostNativeTarget()].filter(Boolean) : nativeTargets;
if (expectedTargets.length === 0) {
  throw new Error(`no bundled native target for ${process.platform}-${process.arch}`);
}
for (const target of expectedTargets) {
  const binary = join("dist", "native", target.label, "fs-safe-native.node");
  if (!existsSync(binary) || statSync(binary).size === 0) {
    throw new Error(`missing or empty bundled binary ${binary}`);
  }
}

const packed = JSON.parse(
  runNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", outputDir],
    { encoding: "utf8" },
  ),
);
const [artifact] = packed;
if (!artifact?.filename || !artifact?.integrity || artifact.version !== pkg.version) {
  throw new Error("npm pack returned incomplete root-package metadata");
}
const paths = new Set(artifact.files.map((file) => file.path));
for (const expected of ["dist/index.js", "dist/index.d.ts", "package.json"]) {
  if (!paths.has(expected)) throw new Error(`packed root package is missing ${expected}`);
}
for (const target of expectedTargets) {
  const binary = `dist/native/${target.label}/fs-safe-native.node`;
  if (!paths.has(binary)) throw new Error(`packed root package is missing ${binary}`);
}
if (!allowHostOnly) {
  const packedNativePaths = [...paths].filter((path) => path.endsWith("/fs-safe-native.node"));
  if (packedNativePaths.length !== nativeTargets.length) {
    throw new Error(`packed root package has ${packedNativePaths.length} native binaries, expected 7`);
  }
}

const manifest = [
  {
    name: pkg.name,
    version: pkg.version,
    filename: artifact.filename,
    integrity: artifact.integrity,
    size: artifact.size,
    unpackedSize: artifact.unpackedSize,
  },
];
writeFileSync(join(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

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
      join(outputDir, artifact.filename),
    ],
    { cwd: smoke, stdio: "pipe" },
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "await import('@openclaw/fs-safe'); await import('@openclaw/fs-safe/config');",
    ],
    { cwd: smoke, stdio: "pipe" },
  );

  const fixture = join(smoke, "fixture.txt");
  writeFileSync(fixture, "abc");
  const nativeProof = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import {configureFsSafeNative} from '@openclaw/fs-safe';" +
        "import {sha256File} from '@openclaw/fs-safe/durability';" +
        "configureFsSafeNative({mode:'require'});" +
        `const result=await sha256File(${JSON.stringify(fixture)});` +
        "if(result.digest!=='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')throw new Error('native hash mismatch');" +
        "console.log(JSON.stringify(result));",
    ],
    { cwd: smoke, encoding: "utf8" },
  ).trim();

  const installedNative = join(smoke, "node_modules", "@openclaw", "fs-safe", "dist", "native");
  const hiddenNative = `${installedNative}.removed`;
  renameSync(installedNative, hiddenNative);
  const fallbackProof = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import {configureFsSafeNative} from '@openclaw/fs-safe';" +
        "import {sha256File} from '@openclaw/fs-safe/durability';" +
        "configureFsSafeNative({mode:'auto'});" +
        `const result=await sha256File(${JSON.stringify(fixture)});` +
        "if(result.digest!=='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')throw new Error('fallback hash mismatch');" +
        "console.log(JSON.stringify(result));",
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
  console.log(`auto fallback without bundled directory: ${fallbackProof}`);
  console.log(`required mode without bundled directory: ${requiredProof}`);
} finally {
  rmSync(smoke, { recursive: true, force: true });
}

console.log(`packed tarball: ${artifact.filename}`);
console.log(`gzipped size: ${artifact.size} bytes`);
console.log(`unpacked size: ${artifact.unpackedSize} bytes`);
