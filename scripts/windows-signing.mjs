import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { list } from "tar";

export const windowsSigner = "CN=OpenClaw Foundation, O=OpenClaw Foundation, L=Mill Valley, S=California, C=US";
export const windowsFiles = [
  { file: "fs-safe-native.win32-x64-msvc.node", package: "@openclaw/fs-safe-win32-x64-msvc", packed: "fs-safe-native.node" },
  { file: "fs-safe-native.win32-arm64-msvc.node", package: "@openclaw/fs-safe-win32-arm64-msvc", packed: "fs-safe-native.node" },
  { file: "windows-security-helper.exe", package: "@openclaw/fs-safe", packed: "dist/windows-security-helper.exe" },
];

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function recordBuild(file) {
  writeFileSync(`${file}.sha256`, `${sha256(readFileSync(file))}\n`);
}

export function prepareSigning(directory, referenceHelper) {
  const hashes = Object.fromEntries(windowsFiles.map(({ file }) => {
    const path = join(directory, file);
    const hash = sha256(readFileSync(path));
    assert.equal(hash, readFileSync(`${path}.sha256`, "utf8").trim(), `${file}: build SHA-256 mismatch`);
    return [file, hash];
  }));
  const reference = sha256(readFileSync(referenceHelper));
  assert.equal(reference, readFileSync(`${referenceHelper}.sha256`, "utf8").trim(), "reference helper: build SHA-256 mismatch");
  assert.equal(hashes["windows-security-helper.exe"], reference, "Ubuntu/Windows unsigned helper differs");
  writeFileSync(join(directory, "unsigned-windows-sha256.json"), `${JSON.stringify(hashes, null, 2)}\n`);
}

export function readSigningManifest(path) {
  assert.ok(path, "release collection requires --windows-signing-manifest from the Windows signing job; see RELEASE-PREREQS.md");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(manifest.version, 1, "unsupported Windows signing manifest");
  assert.deepEqual(Object.keys(manifest.files).sort(), windowsFiles.map(({ file }) => file).sort());
  for (const [file, proof] of Object.entries(manifest.files)) {
    assert.equal(proof.status, "Valid", `${file}: signature must be Valid`);
    assert.equal(proof.subject, windowsSigner, `${file}: unexpected signer`);
    assert.match(proof.timestampThumbprint, /^[a-fA-F0-9]{40,64}$/, `${file}: missing timestamp`);
    assert.match(proof.unsignedSha256, /^[a-f0-9]{64}$/);
    assert.match(proof.signedSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(proof.signedSha256, proof.unsignedSha256, `${file}: signing did not change the binary`);
  }
  return manifest;
}

// Windows validates Authenticode; collection binds that proof to the actual tar entries.
export async function verifyWindowsPackage(manifest, packageName, tarball) {
  const expected = windowsFiles.find((entry) => entry.package === packageName);
  if (!expected) return;
  let matches = 0;
  let actual;
  await list({ file: tarball, onReadEntry(entry) {
    if (entry.path !== `package/${expected.packed}`) return;
    matches++;
    assert.equal(entry.type, "File", `${expected.file}: packed binary must be a regular file`);
    const hash = createHash("sha256");
    entry.on("data", (chunk) => hash.update(chunk));
    entry.on("end", () => { actual = hash.digest("hex"); });
  } });
  assert.equal(matches, 1, `${expected.file}: expected exactly one packed binary`);
  assert.equal(actual, manifest.files[expected.file].signedSha256, `${expected.file}: packed bytes differ from the verified signed binary`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "record" && args.length === 1) recordBuild(args[0]);
  else if (command === "prepare" && args.length === 2) prepareSigning(...args);
  else throw new Error("usage: windows-signing.mjs record <binary> | prepare <directory> <reference-helper>");
}
