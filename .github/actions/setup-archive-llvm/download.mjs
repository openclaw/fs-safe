import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
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

// Cache transport is not an integrity boundary: verify compressed bytes before
// extraction, and rebuild a corrupt entry through the same pinned download.
export async function ensureArchive(url, archive, expectedHash, sdkName) {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest("hex") === expectedHash) return;
    console.warn(`Cached LLVM checksum mismatch: ${sdkName}; downloading the pinned archive.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rm(archive, { force: true });
  try {
    await downloadArchive(url, archive, expectedHash, sdkName);
  } catch (error) {
    await rm(archive, { force: true });
    throw error;
  }
}
