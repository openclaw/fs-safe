import assert from "node:assert/strict";
import JSZip from "jszip";
import { configureFsSafeNative } from "../dist/native-config.js";
import { getNativeBinding } from "../dist/native.js";
import { resolveTarMeterLimits } from "../dist/archive-limits.js";

assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
configureFsSafeNative({ mode: "require" });
const native = getNativeBinding();
const payload = Buffer.alloc(1024 * 1024, 42);
const zip = new JSZip();
zip.file("payload", payload);
const fixture = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

for (let round = 0; round < 3; round++) {
  let input = Buffer.allocUnsafeSlow(fixture.length);
  fixture.copy(input);
  let reader = await native.openZipBufferNative(input, resolveTarMeterLimits());
  input = undefined;
  await new Promise(resolve => setImmediate(resolve));
  globalThis.gc();
  const pending = Array.from({ length: 8 }, () => reader.readEntry(0, payload.length));
  reader = undefined;
  globalThis.gc();
  const results = await Promise.all(pending);
  for (const result of results) assert.ok(result.equals(payload));
  await new Promise(resolve => setImmediate(resolve));
  globalThis.gc();
}
console.log(JSON.stringify({ proof: "native-zip-buffer-gc", reads: 24, outcome: "passed" }));
