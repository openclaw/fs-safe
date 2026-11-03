// Canonical text snapshots keep synthetic binary inputs reviewable in Git.
import assert from "node:assert/strict";

export function encodeFixture(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0, "fixture bytes must be nonempty");
  return bytes.toString("hex").match(/.{1,128}/g).join("\n") + "\n";
}

export function decodeFixture(text) {
  assert.match(text, /^(?:[0-9a-f]{128}\n)*(?:[0-9a-f]{2}){1,64}\n$/, "fixture must be canonical lowercase hex");
  return Buffer.from(text.replaceAll("\n", ""), "hex");
}
