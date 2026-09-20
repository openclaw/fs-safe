import assert from "node:assert/strict";

export function registerZipCountSearch({ api, register }, ordinaryZip) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const dense = Buffer.alloc(65_535, 0xff);
  for (let offset = 0; offset < dense.length; offset += 4) signature.copy(dense, offset);
  for (const [name, comment] of [
    ["no-comment", Buffer.alloc(0)],
    ["short-comment", Buffer.from("ordinary archive comment")],
    ["max-comment", Buffer.alloc(65_535, 0x61)],
    ["dense-comment", dense],
  ]) {
    const bytes = Buffer.concat([ordinaryZip, comment]);
    bytes.writeUInt16LE(comment.length, ordinaryZip.length - 2);
    assert.equal(api.readZipCentralDirectoryEntryCount(bytes), 1);
    register(`readZipCentralDirectoryEntryCount/end-search-${name}`,
      () => api.readZipCentralDirectoryEntryCount(bytes), {
        sync: true, batch: 100, verify: count => assert.equal(count, 1),
      });
  }
  const invalid = Buffer.alloc(128 * 1024, 0x61);
  register("readZipCentralDirectoryEntryCount/end-search-missing-record",
    () => api.readZipCentralDirectoryEntryCount(invalid), {
      sync: true, batch: 100, verify: count => assert.equal(count, null),
    });
}
