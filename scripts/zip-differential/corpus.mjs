import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureCrc32, zipRecords, unicodePath, zipExtra } from "../../test/helpers/zip-records.ts";

function unicodeComment(previous, value) {
  const header = Buffer.alloc(5); header[0] = 1; header.writeUInt32LE(fixtureCrc32(previous), 1);
  return zipExtra(0x6375, Buffer.concat([header, Buffer.from(value)]));
}

// Generated on demand: no large decoded payloads or additional dependencies.
export function syntheticCorpus({ large = false } = {}) {
  const cases = [];
  const add = (id, records, options = {}, extra = {}) => cases.push({ id, bytes: zipRecords(records, options), ...extra });
  const one = (id, record = {}, options = {}) => add(id, [{ name: "payload", ...record }], options);
  one("stored"); one("deflate", { deflate: true });
  one("descriptor", { descriptor: true, deflate: true });
  one("zip64-descriptor", { zip64: true, descriptor: true, deflate: true }, { zip64: true });
  one("zip64", { zip64: true }, { zip64: true });
  for (const [id, name, flags] of [
    ["cp437", Buffer.from([0x63, 0x61, 0x66, 0x82]), 0],
    ["cp437-all-high", Buffer.from(Array.from({ length: 128 }, (_, i) => 128 + i)), 0],
    ["utf8", "café-雪", 0x800], ["utf8-unflagged", "café-雪", 0],
    ["utf8-invalid", Buffer.from([0xff, 0xfe]), 0x800],
    ["utf8-overlong", Buffer.from([0xc0, 0xae, 0xc0, 0xae, 0x2f, 0x78]), 0x800],
    ["utf8-surrogate", Buffer.from([0xed, 0xa0, 0x80]), 0x800],
    ["utf8-truncated", Buffer.from([0xe2, 0x82]), 0x800],
    ["empty-name", "", 0], ["dot", ".", 0], ["parent", "../escape", 0],
    ["absolute", "/zip9-escape", 0], ["drive", "C:/zip9-escape", 0],
    ["drive-relative", "C:zip9-escape", 0], ["unc", "\\\\localhost\\C$\\zip9-escape", 0],
    ["backslash", "nested\\payload", 0], ["nul", "payload\0hidden", 0],
    ["long-component", "a".repeat(256), 0], ["max-name", "a".repeat(65535), 0],
    ["long-path", Array(12).fill("a".repeat(64)).join("/"), 0],
    ["too-many-components", Array(260).fill("abc").join("/"), 0],
  ]) one(id, { name, flags });
  for (const [id, raw, decoded, flags] of [
    ["unicode-agrees", "payload", "payload", 0],
    ["unicode-override", "legacy", "café", 0],
    ["unicode-flag-agrees", "café", "café", 0x800],
    ["unicode-flag-disagrees", "payload", "different", 0x800],
    ["unicode-unsafe-raw", "../escape", "safe", 0],
    ["unicode-unsafe-override", "payload", "../escape", 0],
  ]) {
    const extra = unicodePath(Buffer.from(raw), decoded);
    one(id, { name: raw, flags, extra, localExtra: extra });
  }
  one("unicode-local-disagrees", { extra: unicodePath(Buffer.from("payload"), "one"), localExtra: unicodePath(Buffer.from("payload"), "two") });
  const badCrc = unicodePath(Buffer.from("payload"), "alternate"); badCrc[5] ^= 1;
  one("unicode-bad-crc", { extra: badCrc });
  const invalidUnicode = unicodePath(Buffer.from("payload"), "x"); invalidUnicode[9] = 0xff;
  one("unicode-invalid-utf8", { extra: invalidUnicode });
  one("flagged-unicode-bad-crc", { flags: 0x800, extra: badCrc });
  const invalidRaw = Buffer.from([0xff]);
  one("invalid-utf8-with-override", { name: invalidRaw, flags: 0x800, extra: unicodePath(invalidRaw, "safe") });
  const comment = Buffer.from("original comment");
  const commentExtra = unicodeComment(comment, "Unicode comment");
  const badCommentCrc = Buffer.from(commentExtra); badCommentCrc[5] ^= 1;
  one("unicode-comment-valid", { comment, extra: commentExtra });
  one("unicode-comment-bad-crc", { comment, extra: badCommentCrc });
  one("unicode-comment-invalid-utf8", { comment, extra: unicodeComment(comment, Buffer.from([0xff])) });
  one("unicode-comment-legacy", { comment: Buffer.from([0x82]), extra: unicodeComment(Buffer.from("é"), "Unicode comment") });
  one("unicode-comment-legacy-raw-crc", { comment: Buffer.from([0x82]), extra: unicodeComment(Buffer.from([0x82]), "Unicode comment") });
  one("unicode-comment-flagged-invalid-raw", { flags: 0x800, comment: Buffer.from([0xff]), extra: unicodeComment(Buffer.from("�"), "Unicode comment") });
  one("unicode-comment-valid-chain", { comment, extra: Buffer.concat([commentExtra, unicodeComment(Buffer.from("Unicode comment"), "last")]) });
  one("unicode-comment-bad-chain", { comment, extra: Buffer.concat([commentExtra, commentExtra]) });
  const pathExtra = unicodePath(Buffer.from("payload"), "first");
  one("unicode-path-valid-chain", { extra: Buffer.concat([pathExtra, unicodePath(Buffer.from("first"), "last")]) });
  one("unicode-path-bad-chain", { extra: Buffer.concat([pathExtra, pathExtra]) });
  add("legacy-unicode-collision", [{ name: "keep" }, { name: Buffer.from("é") }, { name: "├⌐", flags: 0x800 }]);
  for (const [index, name] of ["./", ".\\", ".", "././"].entries()) {
    add(`root-directory-${index}`, [{ name, body: "", attributes: 0x41ed0010 }, { name: "payload" }]);
  }
  for (const [id, names] of [
    ["duplicate", ["payload", "payload"]], ["case-collision", ["A", "a"]],
    ["directory-file-collision", ["A/", "a"]], ["nfc-collision", ["café", "cafe\u0301"]],
    ["slash-collision", ["a/b", "a\\b"]], ["dot-collision", ["a/./b", "a/b"]],
  ]) add(id, names.map(name => ({ name, flags: 0x800 })));
  for (const creatorSystem of [0, 3, 10, 19, 255]) {
    for (const [label, mode] of [
      ["zero", 0], ["rwx", 0o100751], ["setuid", 0o104755], ["setgid", 0o102755],
      ["sticky", 0o101755], ["special-only", 0o7000], ["directory", 0o040755],
      ["fifo", 0o010644], ["char", 0o020644], ["block", 0o060644],
      ["socket", 0o140644], ["other", 0o160644], ["junk", 0xffff],
    ]) one(`creator-${creatorSystem}-${label}`, { creatorSystem, attributes: (mode << 16) >>> 0 });
    for (const [label, target] of [["relative", "target"], ["absolute", "/zip9-escape"], ["escaping", "../escape"]]) {
      one(`creator-${creatorSystem}-symlink-${label}`, { creatorSystem, attributes: 0xa1ff0000, body: target });
    }
    one(`creator-${creatorSystem}-dos-directory`, { creatorSystem, attributes: 0x10, body: "" });
    one(`creator-${creatorSystem}-dos-readonly`, { creatorSystem, attributes: 1 });
    one(`creator-${creatorSystem}-slash-directory`, { name: "dir/", creatorSystem, attributes: 0, body: "" });
  }
  add("comment-only", [], { comment: Buffer.from("synthetic ZIP comment") });
  one("comment-signatures", {}, { comment: Buffer.from("PK\x05\x06".repeat(1000)) });
  one("sfx-stub", {}, { prefix: Buffer.from("MZ synthetic self-extractor stub\0") });
  one("local-central-name-mismatch", { localName: "another" });
  one("local-central-safe-alias", { name: "nested/payload", localName: "nested\\payload" });
  one("encrypted-flag", { flags: 1 });
  for (const method of [12, 93, 99]) {
    const bytes = zipRecords([{ name: "payload" }]);
    bytes.writeUInt16LE(method, 8); bytes.writeUInt16LE(method, bytes.indexOf(Buffer.from("PK\x01\x02")) + 10);
    cases.push({ id: `unsupported-method-${method}`, bytes });
  }
  const base = zipRecords([{ name: "payload" }]);
  const cd = base.indexOf(Buffer.from("PK\x01\x02"));
  const eocd = base.length - 22;
  for (const [id, modify] of [
    ["huge-offset", bytes => bytes.writeUInt32LE(0xfffffff0, cd + 42)],
    ["negative-offset-bits", bytes => bytes.writeUInt32LE(0x80000000, cd + 42)],
    ["local-central-size-mismatch", bytes => bytes.writeUInt32LE(123, 22)],
    ["local-central-crc-mismatch", bytes => bytes.writeUInt32LE(123, 14)],
    ["local-central-method-mismatch", bytes => bytes.writeUInt16LE(8, 8)],
  ]) { const bytes = Buffer.from(base); modify(bytes); cases.push({ id, bytes }); }
  cases.push({ id: "truncated-directory", bytes: base.subarray(0, cd + 20) });
  cases.push({ id: "trailing-junk", bytes: Buffer.concat([base, Buffer.from("junk")]) });
  cases.push({ id: "trailing-signature-scan", bytes: Buffer.concat([base, Buffer.from("PK\x05\x06".repeat(200))]) });
  cases.push({ id: "duplicate-directory", bytes: Buffer.concat([base.subarray(0, eocd), base.subarray(cd)]) });
  cases.push({ id: "duplicate-eocd", bytes: Buffer.concat([base, base.subarray(eocd)]) });
  const overlap = zipRecords([{ name: "first" }, { name: "other" }]);
  const secondCd = overlap.indexOf(Buffer.from("PK\x01\x02"), overlap.indexOf(Buffer.from("PK\x01\x02")) + 4);
  overlap.writeUInt32LE(0, secondCd + 42);
  cases.push({ id: "overlapping-local-entry", bytes: overlap });
  const overlappingPayloads = zipRecords([{ name: "first" }, { name: "other" }]);
  const overlapCd = overlappingPayloads.indexOf(Buffer.from("PK\x01\x02"));
  const payload = overlappingPayloads.subarray(35, overlapCd);
  for (const [crcOffset, compressedOffset, sizeOffset] of [[14, 18, 22], [overlapCd + 16, overlapCd + 20, overlapCd + 24]]) {
    overlappingPayloads.writeUInt32LE(fixtureCrc32(payload), crcOffset);
    overlappingPayloads.writeUInt32LE(payload.length, compressedOffset); overlappingPayloads.writeUInt32LE(payload.length, sizeOffset);
  }
  cases.push({ id: "overlapping-payloads", bytes: overlappingPayloads });
  const huge = zipRecords([{ name: "payload", zip64: true }], { zip64: true });
  huge.writeBigUInt64LE(0x100000001n, 30 + 7 + 4);
  huge.writeBigUInt64LE(0x100000001n, huge.indexOf(Buffer.from("PK\x01\x02")) + 46 + 7 + 4);
  cases.push({ id: "zip64-huge-declared", bytes: huge });
  if (large) add("zip64-65537-entries", Array.from({ length: 65537 }, (_, i) => ({ name: `entry-${i}`, body: "" })), { zip64: true }, { large: true });
  return cases;
}

export async function writeCorpus(directory, options) {
  await fs.mkdir(directory, { recursive: true });
  const manifest = [];
  for (const { bytes, ...entry } of syntheticCorpus(options)) {
    await fs.writeFile(path.join(directory, `${entry.id}.zip`), bytes);
    manifest.push({ ...entry, producer: "synthetic", bytes: bytes.length });
  }
  if (options?.producers) {
    const catalog = JSON.parse(await fs.readFile(new URL("./producer-fixtures.json", import.meta.url), "utf8"));
    if (catalog.schema !== 1 || !Array.isArray(catalog.fixtures) || catalog.fixtures.length > 64) throw new Error("invalid producer catalog");
    for (const { base64, ...entry } of catalog.fixtures) {
      if (!/^[a-z0-9-]+$/.test(entry.id) || typeof base64 !== "string" || base64.length > 256 * 1024 || manifest.some(record => record.id === entry.id)) throw new Error("invalid producer fixture");
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`producer checksum mismatch: ${entry.id}`);
      await fs.writeFile(path.join(directory, `${entry.id}.zip`), bytes);
      manifest.push(entry);
    }
  }
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: node scripts/zip-differential/corpus.mjs <output> [--large] [--producers]");
  console.log(JSON.stringify({ cases: (await writeCorpus(path.resolve(process.argv[2]), { large: process.argv.includes("--large"), producers: process.argv.includes("--producers") })).length }));
}
