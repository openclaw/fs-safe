import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Header } from "tar";

function member(name, type, body) {
  const bytes = Buffer.alloc(512 + Math.ceil(body.length / 512) * 512);
  new Header({ path: name, type, size: body.length, mode: 0o644,
    uid: 0, gid: 0, mtime: new Date(0) }).encode(bytes);
  body.copy(bytes, 512);
  return bytes;
}

function paxPath(name) {
  const record = ` path=${name}\n`;
  const bytes = Buffer.byteLength(record);
  let length = bytes + 1;
  while (length !== bytes + String(length).length) length = bytes + String(length).length;
  return Buffer.from(`${length}${record}`);
}

export function registerTarMemberPaths({ api, workspace, register }) {
  const count = 5000;
  const payload = Buffer.from("payload");
  for (const shape of ["ascii", "nfc", "nfd", "prefix-nfc", "pax-nfc", "gnu-nfc"]) {
    const stem = shape === "ascii" ? "member" : shape === "nfd" ? "e\u0301".repeat(20) : "\u00e9".repeat(20);
    const names = Array.from({ length: count }, (_, index) =>
      `${shape === "prefix-nfc" ? "component/".repeat(12) : ""}${stem}-${index}`);
    const records = [];
    for (const [index, name] of names.entries()) {
      if (shape === "pax-nfc") records.push(member("PaxHeader", "ExtendedHeader", paxPath(name)));
      if (shape === "gnu-nfc") records.push(member("LongName", "NextFileHasLongPath", Buffer.from(`${name}\0`)));
      records.push(member(shape === "pax-nfc" || shape === "gnu-nfc" ? `raw-${index}` : name, "File", payload));
    }
    records.push(Buffer.alloc(1024));
    const archivePath = path.join(workspace, `tar-member-paths-${shape}.tar`);
    fs.writeFileSync(archivePath, Buffer.concat(records));
    register(`inspectTarArchive/tar-member-paths-${shape}`, () => api.inspectTarArchive({ archivePath, timeoutMs: 30_000 }), {
      divisor: 100,
      verify(entries) {
        assert.equal(entries.length, count);
        for (const [index, entry] of entries.entries()) {
          assert.deepEqual(entry, { path: names[index], kind: "file", size: payload.length });
        }
      },
    });
  }
}
