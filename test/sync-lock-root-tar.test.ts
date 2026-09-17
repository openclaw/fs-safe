import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  SYNC_LOCK_ROOT_TAR_LIMITS,
  validateSyncLockRootTarBytes,
} from "../benchmarks/sync-lock-root-tar.mjs";

type Entry = { name: string; type?: string; body?: Buffer; declaredSize?: number };
type NumericEncoding = "generator" | "full-width" | "leading-spaces" |
  "trailing-nuls" | "trailing-spaces" | "trailing-space-nul" | "leading-and-mixed";
type NumericField = {
  name: string;
  parsedName: string;
  start: number;
  width: number;
  value: number;
};

const roots: string[] = [];
const numericFields: NumericField[] = [
  { name: "mode", parsedName: "tar mode", start: 100, width: 8, value: 0o600 },
  { name: "uid", parsedName: "tar uid", start: 108, width: 8, value: 0 },
  { name: "gid", parsedName: "tar gid", start: 116, width: 8, value: 0 },
  { name: "size", parsedName: "tar entry size", start: 124, width: 12, value: 4 },
  { name: "mtime", parsedName: "tar mtime", start: 136, width: 12, value: 0 },
  { name: "checksum", parsedName: "tar checksum", start: 148, width: 8, value: 0 },
  { name: "device major", parsedName: "tar device major", start: 329, width: 8, value: 0 },
  { name: "device minor", parsedName: "tar device minor", start: 337, width: 8, value: 0 },
];

function octal(value: number, width: number) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function headerFor({ name, type = "0", body = Buffer.alloc(0), declaredSize }: Entry) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(octal(type === "5" ? 0o700 : 0o600, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(declaredSize ?? body.length, 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii");
  header.fill(32, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(octal(0, 8), 329, 8, "ascii");
  header.write(octal(0, 8), 337, 8, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function archive(entries: Entry[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    chunks.push(headerFor(entry), body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(chunks));
}

function checksumHeader(header: Buffer) {
  header.fill(32, 148, 156);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

function mutateHeader(input: Buffer, mutation: (header: Buffer) => void, checksum = true) {
  const tar = gunzipSync(input);
  const header = tar.subarray(0, 512);
  mutation(header);
  if (checksum) checksumHeader(header);
  return gzipSync(tar);
}

function encodedOctal(value: number, width: number, encoding: NumericEncoding) {
  const digits = value.toString(8);
  const remaining = width - digits.length;
  if (remaining < 0) throw new Error("numeric test value exceeds field width");
  if (encoding === "generator") return `${digits.padStart(width - 1, "0")}\0`;
  if (encoding === "full-width") return digits.padStart(width, "0");
  if (encoding === "leading-spaces") return `${" ".repeat(remaining)}${digits}`;
  if (encoding === "trailing-nuls") return `${digits}${"\0".repeat(remaining)}`;
  if (encoding === "trailing-spaces") return `${digits}${" ".repeat(remaining)}`;
  if (encoding === "trailing-space-nul") {
    return `${digits} \0${" ".repeat(remaining - 2)}`;
  }
  const leading = Math.max(1, Math.floor(remaining / 2));
  const trailing = remaining - leading;
  return `${" ".repeat(leading)}${digits}${trailing > 0 ? "\0" : ""}${
    " ".repeat(Math.max(0, trailing - 1))}`;
}

function archiveWithNumericEncoding(encoding: NumericEncoding) {
  const tar = gunzipSync(archive([{ name: "report", body: Buffer.from("data") }]));
  const header = tar.subarray(0, 512);
  for (const field of numericFields.filter(({ name }) => name !== "checksum")) {
    header.write(encodedOctal(field.value, field.width, encoding), field.start,
      field.width, "ascii");
  }
  header.fill(32, 148, 156);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(encodedOctal(checksum, 8, encoding), 148, 8, "ascii");
  return gzipSync(tar);
}

function archiveWithLeadingNul(field: NumericField) {
  const tar = gunzipSync(archive([{ name: "report", body: Buffer.from("data") }]));
  const header = tar.subarray(0, 512);
  if (field.name === "checksum") {
    header.fill(32, 148, 156);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header[148] = 0;
    header.write(checksum.toString(8), 149, 6, "ascii");
  } else {
    header.fill(32, field.start, field.start + field.width);
    header[field.start] = 0;
    header.write(field.value.toString(8), field.start + 1, field.width - 1, "ascii");
    checksumHeader(header);
  }
  return gzipSync(tar);
}

function extractWithSystemTar(bytes: Buffer) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-sync-root-tar-"));
  roots.push(directory);
  const archivePath = path.join(directory, "fixture.tar.gz");
  const output = path.join(directory, "output");
  fs.writeFileSync(archivePath, bytes);
  fs.mkdirSync(output);
  execFileSync("tar", ["--extract", "--gzip", "--file", archivePath, "--directory", output,
    "--no-same-owner", "--no-same-permissions"]);
  return fs.readFileSync(path.join(output, "report"), "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("sync lockRoot outer archive admission", () => {
  it("accepts a bounded ustar tree of only directories and regular files", () => {
    const receipt = validateSyncLockRootTarBytes(archive([
      { name: "./", type: "5" },
      { name: "./study", type: "5" },
      { name: "./study/report.json", body: Buffer.from("{}\n") },
    ]));
    expect(receipt.accepted).toBe(true);
    expect(receipt.entries).toBe(3);
    expect(receipt.totalFileBytes).toBe(3);
    expect(receipt.limits).toEqual(SYNC_LOCK_ROOT_TAR_LIMITS);
  });

  // These representatives cover no padding, leading-only padding, each
  // admitted suffix byte/order, and simultaneous leading/suffix padding.
  it.each([
    "/absolute", "../escape", "safe/../escape", "C:/drive", "safe\\ambiguous",
  ])("rejects unsafe archive path %s", (name) => {
    expect(() => validateSyncLockRootTarBytes(archive([{ name }]))).toThrow();
  });

  it.each(["1", "2", "3", "4", "6", "7", "g", "K", "L", "p", "x"])(
    "rejects special tar entry type %s",
    (type) => {
      expect(() => validateSyncLockRootTarBytes(archive([{ name: "special", type }]))).toThrow();
    },
  );

  it("rejects duplicate normalized names, oversized entries, and corrupt checksums", () => {
    expect(() => validateSyncLockRootTarBytes(archive([
      { name: "./same" }, { name: "same" },
    ]))).toThrow();
    expect(() => validateSyncLockRootTarBytes(archive([{
      name: "large", declaredSize: SYNC_LOCK_ROOT_TAR_LIMITS.fileBytes + 1,
    }]))).toThrow();
    const corrupted = archive([{ name: "report", body: Buffer.from("data") }]);
    corrupted[20] ^= 1;
    expect(() => validateSyncLockRootTarBytes(corrupted)).toThrow();
  });

  it("rejects a root-shaped regular file and an over-budget entry count", () => {
    expect(() => validateSyncLockRootTarBytes(archive([{ name: "./" }]))).toThrow();
    expect(() => validateSyncLockRootTarBytes(archive(Array.from(
      { length: SYNC_LOCK_ROOT_TAR_LIMITS.entries + 1 },
      (_, index) => ({ name: `entry-${index}` }),
    )))).toThrow();
  });

  it("rejects high-bit numeric bytes before checksum or size interpretation", () => {
    const valid = archive([{ name: "report", body: Buffer.from("data") }]);
    const highMode = mutateHeader(valid, (header) => { header[100] = 0xb0; });
    const highSize = mutateHeader(valid, (header) => { header[124] = 0xb0; });
    // The checksum remains numerically correct because the checksum algorithm
    // treats this whole field as spaces; only its raw high-bit padding is bad.
    const highChecksum = mutateHeader(valid, (header) => { header[155] = 0xa0; }, false);
    expect(() => validateSyncLockRootTarBytes(highMode)).toThrow(/non-ASCII octal byte/u);
    expect(() => validateSyncLockRootTarBytes(highSize)).toThrow(/non-ASCII octal byte/u);
    expect(() => validateSyncLockRootTarBytes(highChecksum)).toThrow(/non-ASCII octal byte/u);
  });

  it.each(numericFields)("rejects leading NUL padding in tar $name", (field) => {
    expect(() => validateSyncLockRootTarBytes(archiveWithLeadingNul(field)))
      .toThrow(`${field.parsedName} has invalid leading padding`);
  });

  it.each([{ label: "NUL", terminator: 0 }, { label: "space", terminator: 32 }])(
    "rejects a digit after $label termination in an octal field",
    ({ terminator }) => {
      const invalid = mutateHeader(archive([{ name: "report" }]), (header) => {
        header.fill(32, 100, 108);
        header[100] = 54;
        header[101] = terminator;
        header[102] = 48;
      });
      expect(() => validateSyncLockRootTarBytes(invalid)).toThrow(/digit after padding/u);
    },
  );

  it.each([
    "generator", "full-width", "leading-spaces", "trailing-nuls", "trailing-spaces",
    "trailing-space-nul", "leading-and-mixed",
  ] as const)("agrees with external tar extraction for %s numeric fields", (encoding) => {
    const value = archiveWithNumericEncoding(encoding);
    expect(validateSyncLockRootTarBytes(value).accepted).toBe(true);
    expect(extractWithSystemTar(value)).toBe("data");
  });

  it("requires the exact ustar magic and version bytes", () => {
    const valid = archive([{ name: "report" }]);
    const magic = mutateHeader(valid, (header) => { header[257] = 0xf5; });
    const version = mutateHeader(valid, (header) => { header[263] = 0xb0; });
    expect(() => validateSyncLockRootTarBytes(magic)).toThrow(/ustar magic/u);
    expect(() => validateSyncLockRootTarBytes(version)).toThrow(/ustar version/u);
  });
});
