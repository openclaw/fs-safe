import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";

const [target, size, digest] = process.argv.slice(2);
const expectedBytes = Number(size);
assert.ok(Number.isSafeInteger(expectedBytes) && expectedBytes > 0);
assert.match(digest, /^[a-f0-9]{64}$/);
let missing = 0;
let complete = 0;
let finished = false;
let receiptSent = false;
let scheduled;
const deadline = setTimeout(() => fail(new Error("creation observer exceeded its deadline")), 90_000);

process.once("disconnect", () => {
  finished = true;
  clearImmediate(scheduled);
  clearTimeout(deadline);
  if (!receiptSent) process.exitCode = 1;
});

function observe(final = false) {
  let descriptor;
  try {
    descriptor = fs.openSync(target, "r");
    const bytes = fs.readFileSync(descriptor);
    assert.equal(bytes.length, expectedBytes, "published destination contained incomplete bytes");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
    complete++;
  } catch (error) {
    if (error.code !== "ENOENT" || final) throw error;
    missing++;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fail(error) {
  finished = true;
  clearImmediate(scheduled);
  clearTimeout(deadline);
  console.error(error.message);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}

function poll() {
  if (finished) return;
  try {
    observe();
    scheduled = setImmediate(poll);
  } catch (error) { fail(error); }
}

process.once("message", () => {
  finished = true;
  clearImmediate(scheduled);
  clearTimeout(deadline);
  try {
    observe(true);
    process.send({ missing, complete, allObservedVisibleBytesComplete: true }, (error) => {
      if (error) { fail(error); return; }
      receiptSent = true;
      if (process.connected) process.disconnect();
    });
  } catch (error) { fail(error); }
});
observe();
process.send({ ready: true });
poll();
