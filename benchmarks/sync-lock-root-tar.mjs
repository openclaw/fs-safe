import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

export const SYNC_LOCK_ROOT_TAR_LIMITS = Object.freeze({
  archiveBytes: 128 * 1024 * 1024,
  entries: 1_000,
  fileBytes: 64 * 1024 * 1024,
  totalFileBytes: 256 * 1024 * 1024,
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fieldText(header, start, length, name) {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  const used = end < 0 ? bytes : bytes.subarray(0, end);
  if (end >= 0) {
    assert(bytes.subarray(end).every((byte) => byte === 0), `${name} has bytes after NUL`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(used);
}

function octal(header, start, length, name) {
  const bytes = header.subarray(start, start + length);
  assert(bytes.every((byte) => byte === 0 || byte === 32 || (byte >= 48 && byte <= 55)),
    `${name} contains a non-ASCII octal byte`);
  let index = 0;
  while (index < bytes.length && bytes[index] === 32) index += 1;
  const digitStart = index;
  let value = 0;
  while (index < bytes.length && bytes[index] >= 48 && bytes[index] <= 55) {
    value = value * 8 + bytes[index] - 48;
    assert(Number.isSafeInteger(value), `${name} is outside the safe range`);
    index += 1;
  }
  assert(index > digitStart, `${name} has invalid leading padding`);
  assert(bytes.subarray(index).every((byte) => byte === 0 || byte === 32),
    `${name} has a digit after padding`);
  return value;
}

function validateChecksum(header) {
  const expected = octal(header, 148, 8, "tar checksum");
  let observed = 0;
  for (let index = 0; index < header.length; index += 1) {
    observed += index >= 148 && index < 156 ? 32 : header[index];
  }
  assert.equal(observed, expected, "tar header checksum mismatch");
}

function canonicalName(header, directory) {
  const name = fieldText(header, 0, 100, "tar name");
  const prefix = fieldText(header, 345, 155, "tar prefix");
  let combined = prefix ? `${prefix}/${name}` : name;
  assert(combined.length > 0 && combined.length <= 4_096, "tar path length is invalid");
  assert(!/[\u0000-\u001f\u007f-\u009f]/u.test(combined), "tar path contains control bytes");
  assert(!combined.startsWith("/") && !combined.includes("\\") &&
    !/^[A-Za-z]:/u.test(combined), "tar path is absolute or platform-ambiguous");
  if (combined.startsWith("./")) combined = combined.slice(2);
  if (directory && combined.endsWith("/")) combined = combined.slice(0, -1);
  if (combined === "") {
    assert(directory, "tar root entry is not a directory");
    return ".";
  }
  const parts = combined.split("/");
  assert(parts.every((part) => part !== "" && part !== "." && part !== ".."),
    "tar path contains traversal or an empty component");
  return parts.join("/");
}

export function validateSyncLockRootTarBytes(archive) {
  assert(Buffer.isBuffer(archive), "tar archive must be a Buffer");
  assert(archive.length > 0 && archive.length <= SYNC_LOCK_ROOT_TAR_LIMITS.archiveBytes,
    "compressed tar size is outside the admitted range");
  const tar = gunzipSync(archive, {
    maxOutputLength: SYNC_LOCK_ROOT_TAR_LIMITS.totalFileBytes +
      SYNC_LOCK_ROOT_TAR_LIMITS.entries * 1_024,
  });
  assert.equal(tar.length % 512, 0, "tar length is not block aligned");
  const names = new Set();
  let entries = 0;
  let totalFileBytes = 0;
  let offset = 0;
  let terminated = false;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      const second = tar.subarray(offset + 512, offset + 1_024);
      assert.equal(second.length, 512, "tar has only one end marker");
      assert(second.every((byte) => byte === 0), "tar has only one end marker");
      assert(tar.subarray(offset + 1_024).every((byte) => byte === 0),
        "tar has content after its end markers");
      terminated = true;
      break;
    }
    validateChecksum(header);
    octal(header, 100, 8, "tar mode");
    octal(header, 108, 8, "tar uid");
    octal(header, 116, 8, "tar gid");
    const size = octal(header, 124, 12, "tar entry size");
    octal(header, 136, 12, "tar mtime");
    octal(header, 329, 8, "tar device major");
    octal(header, 337, 8, "tar device minor");
    assert(header.subarray(257, 263).equals(Buffer.from("ustar\0", "ascii")),
      "tar entry has invalid ustar magic");
    assert(header.subarray(263, 265).equals(Buffer.from("00", "ascii")),
      "tar entry has an invalid ustar version");
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    assert(type === "0" || type === "5",
      "tar contains a link, device, or unsupported special entry");
    const directory = type === "5";
    assert(!directory || size === 0, "tar directory has a payload");
    assert(size <= SYNC_LOCK_ROOT_TAR_LIMITS.fileBytes, "tar entry exceeds the file-size limit");
    assert.equal(fieldText(header, 157, 100, "tar link name"), "",
      "tar entry unexpectedly carries a link target");
    const name = canonicalName(header, directory);
    assert.equal(names.has(name), false, `tar contains duplicate path ${name}`);
    names.add(name);
    entries += 1;
    assert(entries <= SYNC_LOCK_ROOT_TAR_LIMITS.entries, "tar entry-count limit exceeded");
    totalFileBytes += size;
    assert(totalFileBytes <= SYNC_LOCK_ROOT_TAR_LIMITS.totalFileBytes,
      "tar total file-size limit exceeded");
    offset += 512 + Math.ceil(size / 512) * 512;
    assert(offset <= tar.length, "tar entry payload is truncated");
  }
  assert(terminated, "tar has no canonical end markers");
  return {
    schema: "fs-safe-sync-lock-root-tar-validation-v1",
    accepted: true,
    archive: { sha256: sha256(archive), size: archive.length },
    entries,
    totalFileBytes,
    limits: { ...SYNC_LOCK_ROOT_TAR_LIMITS },
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    assert(name?.startsWith("--") && value !== undefined, "tar validator options require pairs");
    assert.equal(options[name.slice(2)], undefined, `duplicate tar validator option: ${name}`);
    options[name.slice(2)] = value;
  }
  assert.deepEqual(Object.keys(options).sort(), ["archive", "output"],
    "tar validator option set mismatch");
  return { archive: path.resolve(options.archive), output: path.resolve(options.output) };
}

function main() {
  let output;
  try {
    const options = parseArguments(process.argv);
    output = options.output;
    assert.equal(fs.existsSync(output), false, "tar validation receipt already exists");
    const stat = fs.lstatSync(options.archive, { bigint: true });
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n,
      "tar input is not a private regular file");
    assert(stat.size > 0n && stat.size <= BigInt(SYNC_LOCK_ROOT_TAR_LIMITS.archiveBytes),
      "compressed tar size is outside the admitted range");
    const receipt = validateSyncLockRootTarBytes(fs.readFileSync(options.archive));
    fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (output && !fs.existsSync(output)) {
      fs.writeFileSync(output, `${JSON.stringify({
        schema: "fs-safe-sync-lock-root-tar-validation-v1",
        accepted: false,
        failure: { kind: "validation" },
      }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
    process.stderr.write(`sync lockRoot archive validation failed: ${
      error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
