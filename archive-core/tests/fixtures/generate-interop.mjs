// Deterministic, synthetic parser inputs. No extraction or filesystem metadata capture.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeFixture, encodeFixture } from "../fixture-hex.mjs";

const root = fileURLToPath(new URL("./interop/", import.meta.url));
const pad = (body) => Buffer.alloc((512 - body.length % 512) % 512);
const eof = Buffer.alloc(1024);
function header(name, kind, size, link = "") {
  const block = Buffer.alloc(512);
  Buffer.from(name).copy(block, 0);
  Buffer.from("0000644\0").copy(block, 100);
  Buffer.from("0000000\0").copy(block, 108);
  Buffer.from("0000000\0").copy(block, 116);
  Buffer.from(`${size.toString(8).padStart(11, "0")}\0`).copy(block, 124);
  Buffer.from("00000000000\0").copy(block, 136);
  block[156] = kind.charCodeAt(0);
  Buffer.from(link).copy(block, 157);
  Buffer.from("ustar\0" + "00").copy(block, 257);
  block.fill(32, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `).copy(block, 148);
  return block;
}
function member(name, kind = "0", body = Buffer.alloc(0), link = "") {
  body = Buffer.from(body);
  return Buffer.concat([header(name, kind, body.length, link), body, pad(body)]);
}
function record(key, value) {
  const suffix = Buffer.from(` ${key}=${value}\n`);
  let length = suffix.length + 1;
  while (length !== String(length).length + suffix.length) length = String(length).length + suffix.length;
  return Buffer.concat([Buffer.from(String(length)), suffix]);
}
const pax = (key, value) => member("PaxHeader", "x", record(key, value));
const complete = (...parts) => Buffer.concat([...parts, eof]);
const file = member("file", "0", "alpha");
const link = member("link", "2", "", "target");
const long = `nested/${"a".repeat(180)}/leaf`;
const invalidHeader = "archive-header-invalid: ";
// Explicit identities/ranges are an independent oracle for the WASM events.
// Offsets reflect the fixed 512-byte headers and padded metadata in this corpus.
const event = (path, type, offset, payload) => ({
  path, type: type.charCodeAt(0), size: Buffer.byteLength(payload), mode: 0o644, offset,
  payloadSha256: createHash("sha256").update(payload).digest("hex"),
});
const expectedMembers = {
  "ordinary-file": [event("file", "0", 512, "alpha")],
  "plain-symlink": [event("link", "2", 512, "")],
  "plain-hardlink": [event("hardlink", "1", 512, "")],
  "long-pax-path": [event(long, "0", 1536, "alpha")],
  "long-gnu-path": [event(long, "0", 1536, "alpha")],
  "unicode-spelling": [event("caf\u00e9", "0", 1536, "alpha"), event("cafe\u0301", "0", 3584, "alpha")],
  "empty-archive": [],
  "case-spelling": [event("File", "0", 512, "upper"), event("file", "0", 1536, "alpha")],
  "colon-name": [event("file:stream", "0", 512, "alpha")],
};
const cases = [];
function add(id, bytes, posix = "ok", windows = posix, reference = "accept", limits = {}) {
  cases.push({ id, bytes, posix, windows, reference, ...limits });
}
add("ordinary-file", complete(file));
add("directory-link-pax", complete(pax("LIBARCHIVE.symlinktype", "dir"), link),
  invalidHeader + "unsupported or malformed PAX metadata");
// Golden bytes emitted by examples/directory-link-reproducer.rs with tar 0.4.46.
// Keep this producer output distinct from the named, hand-framed PAX control.
add("rust-tar-directory-link", decodeFixture(readFileSync(new URL("./interop/rust-tar-directory-link.tar.hex", import.meta.url), "utf8")),
  invalidHeader + "entry path is empty");
add("plain-symlink", complete(link));
add("plain-hardlink", complete(member("hardlink", "1", "", "file")));
add("long-pax-path", complete(pax("path", long), file));
add("long-gnu-path", complete(member("LongName", "L", `${long}\0`), file));
add("unicode-spelling", complete(pax("path", "caf\u00e9"), file, pax("path", "cafe\u0301"), file));
add("raw-non-utf8", complete(member(Buffer.from([0xff]), "0", "alpha")), "archive-entry-path-invalid");
add("missing-eof", file, invalidHeader + "missing two-block TAR EOF");
add("single-eof", Buffer.concat([file, Buffer.alloc(512)]), invalidHeader + "missing two-block TAR EOF");
add("nonzero-after-eof", Buffer.concat([complete(file), Buffer.from("x")]), invalidHeader + "nonzero data after TAR EOF");
add("truncated-header", file.subarray(0, 200), invalidHeader + "truncated TAR header", undefined, "reject");
add("truncated-data", Buffer.concat([header("file", "0", 8), Buffer.from("abc")]),
  invalidHeader + "truncated TAR entry data", undefined, "reject");
add("empty-archive", eof);
add("case-spelling", complete(member("File", "0", "upper"), file));
add("colon-name", complete(member("file:stream", "0", "alpha")), "ok", "archive-entry-path-invalid");
add("entry-budget", complete(file), "archive-entry-count-exceeds-limit", undefined, "accept", { entries: 0 });
add("metadata-budget", complete(pax("path", long), file), "archive-meta-entry-size-exceeds-limit",
  undefined, "accept", { metadata: 1 });
add("decoded-budget", complete(file), "archive-decoded-size-exceeds-limit",
  undefined, "accept", { decoded: complete(file).length - 1 });
add("manifest-budget", complete(file), "archive-manifest-size-exceeds-limit",
  undefined, "accept", { manifest: 0 });

mkdirSync(root, { recursive: true });
const rows = ["id\tsha256\tbytes\tposix\twindows\treference\tentries\tmetadata\tdecoded\tmanifest"];
for (const test of cases) {
  writeFileSync(`${root}/${test.id}.tar.hex`, encodeFixture(test.bytes));
  rows.push([test.id, createHash("sha256").update(test.bytes).digest("hex"), test.bytes.length,
    test.posix, test.windows, test.reference, test.entries ?? 64, test.metadata ?? 4096,
    test.decoded ?? 65536, test.manifest ?? 65536].join("\t"));
}
writeFileSync(`${root}/cases.tsv`, rows.join("\n") + "\n");
writeFileSync(`${root}/members.json`, JSON.stringify(expectedMembers, null, 2) + "\n");
console.log(JSON.stringify({ cases: cases.length, bytes: cases.reduce((n, test) => n + test.bytes.length, 0) }));
