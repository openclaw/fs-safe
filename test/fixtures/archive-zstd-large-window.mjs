import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createPortableTarDecoder } from "../../dist/archive-codec-wasm.js";

// A valid 128 MiB window followed by 1,025 maximum-size RLE blocks. The input
// is only 4 KiB; output stays streamed so the test measures decoder history.
const count = 1025, size = 128 * 1024;
const bytes = Buffer.alloc(6 + count * 4);
Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0x88]).copy(bytes);
for (let index = 0; index < count; index++) {
  bytes.writeUIntLE(size * 8 + 2 + Number(index === count - 1), 6 + index * 4, 3);
  bytes[6 + index * 4 + 3] = 97;
}
let total = 0, maxChunk = 0;
await pipeline(Readable.from([bytes]), createPortableTarDecoder("tar-zstd", count * size),
  new Writable({ write(chunk, _encoding, done) {
    if (!chunk.every(byte => byte === 97)) { done(new Error("unexpected decoded payload")); return; }
    total += chunk.length; maxChunk = Math.max(maxChunk, chunk.length); done();
  } }));
if (total !== count * size || maxChunk > 65536) throw new Error("invalid bounded decoder output");
process.stdout.write(JSON.stringify({ total, expected: count * size, maxChunk, maxRssBytes: process.resourceUsage().maxRSS * 1024 }));
