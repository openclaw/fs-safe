import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout } from "node:timers/promises";

export async function downloadArchive(url, archive, expectedHash, sdkName) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (response.ok && response.body) {
      const hash = createHash("sha256");
      await pipeline(response.body, new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }), createWriteStream(archive, { flags: "wx" }));
      if (hash.digest("hex") !== expectedHash) throw new Error(`LLVM checksum mismatch: ${sdkName}`);
      return;
    }
    const error = new Error(`LLVM download failed: HTTP ${response.status}`);
    try {
      await response.body?.cancel();
    } catch {
      // Preserve the HTTP failure if disposal of its rejected body also fails.
    }
    if (attempt === 3 || ![408, 500, 502, 503, 504].includes(response.status)) throw error;
    const delay = 1_000 * 2 ** (attempt - 1);
    console.warn(`LLVM download returned HTTP ${response.status}; retrying (${attempt + 1}/3) in ${delay}ms.`);
    await setTimeout(delay);
  }
}
