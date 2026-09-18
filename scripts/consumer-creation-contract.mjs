import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { nativeBinaryLoaded } from "./consumer-proof-metadata.mjs";

export const creationProbeFiles = [
  "consumer-creation-probe.mjs", "consumer-creation-contract.mjs",
  "consumer-creation-observer.mjs", "consumer-creation-acl.ps1",
];
export const creationScenarios = [
  "root-private-directory", "root-private-file", "root-private-json",
  "root-atomic-buffer", "root-atomic-json", "root-stream-publication",
  "advanced-directory-async", "advanced-directory-sync", "advanced-file-descriptor",
];

export function creationScenarioNames(missingRequired, platform) {
  if (!missingRequired) return creationScenarios;
  return [platform === "win32" ? "require-root-mkdir" : "root-private-directory",
    "require-root-create", "require-root-create-json", "require-root-stream",
    ...(platform === "win32"
      ? ["require-directory-async", "require-directory-sync", "require-file-sync"]
      : ["advanced-directory-async", "advanced-directory-sync", "advanced-file-descriptor"])];
}

export function creationHash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Bind the complete executable distribution, including newly added creation backends.
export function creationCompiledFiles(directory) {
  const inventory = {};
  function visit(relative = "") {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      assert.equal(entry.isSymbolicLink(), false, "compiled distribution contains a symlink");
      if (entry.isDirectory()) visit(name);
      else if (/\.(?:js|json|wasm|cs|ps1)$/.test(name)) {
        assert.equal(entry.isFile(), true);
        inventory[name.split(path.sep).join("/")] = creationHash(path.join(directory, name));
      }
    }
  }
  visit();
  assert.ok(Object.keys(inventory).length > 0);
  return Object.fromEntries(Object.entries(inventory).sort(([left], [right]) => left.localeCompare(right)));
}

export function bindCreationConsumer(importUrl, mode) {
  const expected = JSON.parse(fs.readFileSync("expected.json", "utf8"));
  const proof = expected.creation;
  assert.equal(proof.protocol, 1);
  assert.equal(expected.host.os, process.platform);
  assert.equal(expected.host.cpu, process.arch);
  const consumer = fs.realpathSync.native(process.cwd());
  const inside = (file) => {
    const resolved = fs.realpathSync.native(file);
    const relative = path.relative(consumer, resolved);
    assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    return resolved;
  };
  const require = createRequire(importUrl);
  const manifest = inside(require.resolve("@openclaw/fs-safe/package.json"));
  const directory = path.dirname(manifest);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest, "utf8")), expected.rootPkg);
  assert.equal(creationHash(inside(require.resolve("@openclaw/fs-safe"))), expected.entryHash);
  const lock = fs.readFileSync(expected.manager.name === "npm" ? "package-lock.json" : "pnpm-lock.yaml", "utf8");
  assert.ok(lock.includes(expected.rootIntegrity));
  for (const [subpath, module] of [["config", "config.js"], ["advanced", "advanced.js"]]) {
    assert.equal(inside(require.resolve(`@openclaw/fs-safe/${subpath}`)), inside(path.join(directory, "dist", module)));
  }
  const compiledFiles = creationCompiledFiles(inside(path.join(directory, "dist")));
  assert.deepEqual(compiledFiles, proof.compiledFiles);
  const probeFiles = Object.fromEntries(creationProbeFiles.map((name) => [name, creationHash(inside(name))]));
  assert.deepEqual(probeFiles, proof.probeFiles);
  assert.equal(creationHash(inside("consumer-proof-metadata.mjs")), expected.metadataHelperSha256);
  const rootRequire = createRequire(manifest);
  let binary;
  for (const name of expected.platforms) {
    if (!expected.omitted && name === expected.host.package) {
      binary = inside(rootRequire.resolve(name));
      assert.equal(creationHash(binary), expected.hostBinarySha256);
    } else assert.throws(() => rootRequire.resolve(name), { code: "MODULE_NOT_FOUND" });
  }
  return {
    expected,
    receipt(rows) {
      const nativeLoaded = binary ? nativeBinaryLoaded(binary) : process.report.getReport().sharedObjects
        .some((file) => /fs-safe.*\.node$/i.test(file));
      assert.equal(nativeLoaded, !expected.omitted && mode === "require");
      assert.deepEqual(rows.map((row) => row.scenario), creationScenarioNames(expected.omitted && mode === "require", process.platform));
      return { protocol: 1, platform: process.platform, arch: process.arch, node: process.version,
        mode, omitted: expected.omitted, nativeLoaded, source: expected.source,
        sourceMetadataProjection: true, rootIntegrity: expected.rootIntegrity,
        packageManager: expected.manager, compiledFiles, probeFiles, rows };
    },
  };
}
