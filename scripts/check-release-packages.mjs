import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { list } from "tar";
import { hostNativeTarget, nativePackageDirectory, nativeTargets } from "./native-targets.mjs";
import { normalizePackResult } from "./npm-pack-result.mjs";
import { assertPackedRuntimeFiles } from "./packed-runtime-files.mjs";
import { resolveNpmCli } from "./npm-cli.mjs";
import { consumerInstallSmoke, isolatedConsumerEnv, resolveConsumerCommands } from "./consumer-install-smoke.mjs";
import { packageProofSource } from "./consumer-proof-metadata.mjs";
import { readSigningManifest, verifyWindowsPackage } from "./windows-signing.mjs";

function readPackage(directory = ".") {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function packPackage(directory, expectedName, outputDir, npmCli, npmEnv) {
  const output = execFileSync(process.execPath,
    [npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", outputDir],
    { cwd: directory, encoding: "utf8", env: npmEnv, timeout: 120_000, killSignal: "SIGKILL" });
  const parsed = JSON.parse(output);
  const normalized = normalizePackResult(parsed, expectedName);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed[expectedName];
  const artifact = { ...entry, ...normalized };
  if (!artifact.filename || !artifact.integrity) {
    throw new Error(`npm pack returned incomplete metadata for ${expectedName}`);
  }
  return artifact;
}

async function verifyArchive(file, pkg, rootName) {
  const paths = new Set();
  const metadata = [];
  const entries = [];
  await list({ file, onReadEntry(entry) {
    if (entry.type === "Directory") return;
    entries.push({ path: entry.path, type: entry.type, size: entry.size });
    if (entry.path === "package/package.json") entry.on("data", chunk => metadata.push(chunk));
  } });
  for (const entry of entries) {
    assert.equal(entry.type, "File", "packed entries must be regular files");
    assert.ok(entry.path.startsWith("package/") && !entry.path.split("/").some(part => part === ".." || part === "."),
      "packed entry is outside package/");
    const path = entry.path.slice("package/".length);
    assert.ok(!paths.has(path), `duplicate packed entry ${path}`);
    paths.add(path);
  }
  assert.deepEqual(JSON.parse(Buffer.concat(metadata).toString("utf8")), pkg, "packed package metadata differs from source");
  if (pkg.name !== rootName) {
    assert.deepEqual([...paths].sort(), ["fs-safe-native.node", "package.json"]);
  } else {
    for (const expected of ["dist/index.js", "dist/index.d.ts", "dist/windows-security-helper.exe", "package.json"]) {
      assert.ok(paths.has(expected), `packed root package is missing ${expected}`);
    }
    assert.ok(![...paths].some(path => path.endsWith(".node")), "packed root package must not contain native binaries");
    await assertPackedRuntimeFiles(file);
  }
  return entries.reduce((total, entry) => total + entry.size, 0);
}

function assertReusableSource(source) {
  assert.match(source.commit ?? "", /^[0-9a-f]{40}$/u);
  assert.match(source.tree ?? "", /^[0-9a-f]{40}$/u);
  assert.equal(source.dirty, false, "packed input requires a clean source checkout");
  if (process.env.FS_SAFE_EXPECTED_SOURCE_COMMIT) {
    assert.equal(source.commit, process.env.FS_SAFE_EXPECTED_SOURCE_COMMIT);
  }
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function readPackedFile(directory, filename) {
  assert.equal(basename(filename), filename);
  const file = join(directory, filename);
  assert.ok(lstatSync(file).isFile(), "packed input must be a regular file");
  assert.equal(realpathSync(file), join(realpathSync(directory), filename), "packed input escapes its directory");
  return readFileSync(file);
}

export async function verifyPackedInput({ directory, rootPkg, hostPkg, source, host }) {
  assertReusableSource(source);
  const manifestBytes = readPackedFile(directory, "manifest.json");
  const receipt = JSON.parse(readPackedFile(directory, "package-build-proof.json"));
  assert.deepEqual(receipt, { schema: 1, source, host, manifestSha256: sha256(manifestBytes) },
    "packed input source, host, or manifest binding differs");
  const manifest = JSON.parse(manifestBytes);
  assert.ok(Array.isArray(manifest));
  assert.equal(manifest.length, 2, "packed input must contain exactly root and host artifacts");
  for (const pkg of [hostPkg, rootPkg]) {
    const matches = manifest.filter(entry => entry.name === pkg.name);
    assert.equal(matches.length, 1, `missing unique packed artifact ${pkg.name}`);
    const entry = matches[0];
    assert.equal(entry.version, pkg.version);
    assert.equal(entry.filename, `${pkg.name.replace(/^@/u, "").replaceAll("/", "-")}-${pkg.version}.tgz`);
    const file = join(directory, entry.filename);
    const bytes = readPackedFile(directory, entry.filename);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0);
    assert.equal(bytes.length, entry.size, "packed artifact size differs");
    assert.ok(Number.isSafeInteger(entry.unpackedSize) && entry.unpackedSize > 0);
    assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, entry.integrity,
      `artifact integrity: ${pkg.name}`);
    assert.equal(await verifyArchive(file, pkg, rootPkg.name), entry.unpackedSize, "unpacked artifact size differs");
  }
  return manifest;
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
  const { values } = parseArgs({ options: {
    output: { type: "string", default: "release-artifacts" },
    "allow-host-only": { type: "boolean" },
    "windows-signing-manifest": { type: "string" },
    "pack-only": { type: "boolean" },
    "packed-input": { type: "string" },
  } });
  const allowHostOnly = values["allow-host-only"] ?? false;
  assert.ok(values["packed-input"] === undefined || values["packed-input"].length > 0, "packed-input must not be empty");
  const packedInput = values["packed-input"] === undefined ? undefined : resolve(values["packed-input"]);
  const packOnly = values["pack-only"] ?? false;
  assert.ok(!(packOnly && packedInput), "pack-only and packed-input are mutually exclusive");
  assert.ok(!(packOnly || packedInput) || allowHostOnly, "packed reuse requires host-only collection");
  assert.ok(!packedInput || !values["windows-signing-manifest"], "signed collection must pack and verify its own artifacts");
  const npmCli = resolveNpmCli();
  const consumerCommands = resolveConsumerCommands(npmCli);
  const outputDir = resolve(values.output);
  mkdirSync(outputDir, { recursive: true });
  const packingConfig = mkdtempSync(join(tmpdir(), "fs-safe-pack-config-"));
  try {
    const npmEnv = isolatedConsumerEnv(packingConfig);
    const source = packageProofSource();
    if (source.unavailable) console.warn(`source revision unavailable: ${source.unavailable}; artifact and behavior proof remain separate`);
    const rootPkg = readPackage();
    if (rootPkg.name !== "@openclaw/fs-safe") throw new Error(`unexpected package name ${rootPkg.name}`);
    if (rootPkg.author !== "OpenClaw Team <dev@openclaw.ai>") {
      throw new Error("root package has unexpected author metadata");
    }
    if (rootPkg.publishConfig?.access !== "public" || rootPkg.publishConfig?.provenance !== true) {
      throw new Error("root package must publish publicly with provenance");
    }
    const signingManifest = !allowHostOnly || values["windows-signing-manifest"]
      ? readSigningManifest(values["windows-signing-manifest"])
      : undefined;

    const targets = allowHostOnly ? [hostNativeTarget()].filter(Boolean) : nativeTargets;
    if (targets.length === 0) throw new Error(`no native target for ${process.platform}-${process.arch}`);

    let manifest = [];
    let hostPkg;
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
      if (packedInput) {
        hostPkg = pkg;
        continue;
      }
      const artifact = packPackage(directory, pkg.name, outputDir, npmCli, npmEnv);
      await verifyArchive(join(outputDir, artifact.filename), pkg, rootPkg.name);
      if (signingManifest) await verifyWindowsPackage(signingManifest, pkg.name, join(outputDir, artifact.filename));
      manifest.push(manifestEntry(pkg, artifact));
    }

    if (packedInput) {
      manifest = await verifyPackedInput({ directory: packedInput, rootPkg, hostPkg, source, host: targets[0].label });
      if (realpathSync(packedInput) !== realpathSync(outputDir)) {
        copyFileSync(join(packedInput, "package-build-proof.json"), join(outputDir, "package-build-proof.json"));
      }
    } else {
      const rootArtifact = packPackage(process.cwd(), rootPkg.name, outputDir, npmCli, npmEnv);
      await verifyArchive(join(outputDir, rootArtifact.filename), rootPkg, rootPkg.name);
      if (signingManifest) await verifyWindowsPackage(signingManifest, rootPkg.name, join(outputDir, rootArtifact.filename));
      manifest.push(manifestEntry(rootPkg, rootArtifact));
    }
    const manifestBytes = packedInput ? readFileSync(join(packedInput, "manifest.json"))
      : `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(outputDir, "manifest.json"), manifestBytes);

    const host = hostNativeTarget();
    if (!host || !targets.some((target) => target.label === host.label)) {
      throw new Error(`release smoke requires the host target ${host?.label ?? "unknown"}`);
    }
    if (packOnly) {
      assertReusableSource(source);
      // Consumers must bind the producer's actual checkout and manifest bytes,
      // rather than infer provenance from an artifact name or repack on failure.
      writeFileSync(join(outputDir, "package-build-proof.json"), `${JSON.stringify({
        schema: 1, source, host: host.label, manifestSha256: sha256(manifestBytes),
      }, null, 2)}\n`);
    } else {
      await consumerInstallSmoke({ rootPkg, manifest, outputDir, artifactDir: packedInput ?? outputDir,
        npmCli, consumerCommands, allowHostOnly, source });
    }
    assert.deepEqual(packageProofSource(), source, "source changed while collecting package proof");

    for (const artifact of manifest) {
      console.log(`${artifact.name}: ${artifact.size} bytes gzipped, ${artifact.unpackedSize} bytes unpacked`);
    }
  } finally {
    rmSync(packingConfig, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
