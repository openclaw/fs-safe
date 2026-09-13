import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { configureFsSafeNative } from "../dist/native-config.js";
import { getNativeBinding } from "../dist/native.js";
import { resolveTarMeterLimits } from "../dist/archive-limits.js";

assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
configureFsSafeNative({ mode: "require" });
const native = getNativeBinding();
const payload = Buffer.alloc(1024 * 1024, 42);
const header = Buffer.alloc(512);
header.write("payload");
header.write("0000644\0", 100);
header.write(`${payload.length.toString(8).padStart(11, "0")}\0`, 124);
header.fill(32, 148, 156);
header[156] = 48;
header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
const raw = Buffer.concat([header, payload, Buffer.alloc(1024)]);

for (const fixture of [raw, gzipSync(raw)]) {
  for (let round = 0; round < 3; round++) {
    let input = Buffer.allocUnsafeSlow(fixture.length);
    fixture.copy(input);
    let opening = native.openTarBufferNative(input, "tar", resolveTarMeterLimits());
    input = undefined;
    globalThis.gc();
    let reader = await opening;
    opening = undefined;
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
}
console.log(JSON.stringify({ proof: "native-tar-buffer-gc", reads: 48, outcome: "passed" }));
