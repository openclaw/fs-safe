import fs from "node:fs/promises";
import { Writable } from "node:stream";
import type { Gunzip } from "node:zlib";
import { ArchiveFormatError } from "./archive-errors.js";

/** Track physical input, not the sum of bytes consumed across separate writes:
 * gunzip can resume on a later chunk after leaving an earlier padding gap. */
export class GzipInput extends Writable {
  private position = 0;
  private firstUnused: number | undefined;

  constructor(private readonly decoder: Gunzip) {
    super({ highWaterMark: 65536 });
  }

  get tailOffset(): number {
    return this.firstUnused ?? this.position;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const before = this.decoder.bytesWritten;
    this.decoder.write(chunk, (error) => {
      if (error) { callback(error); return; }
      const used = this.decoder.bytesWritten - before;
      if (!Number.isSafeInteger(used) || used < 0 || used > chunk.length ||
          !Number.isSafeInteger(this.position + chunk.length)) {
        callback(new ArchiveFormatError("invalid gzip consumed-input boundary"));
        return;
      }
      if (used < chunk.length) this.firstUnused ??= this.position + used;
      this.position += chunk.length;
      callback();
    });
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.decoder.end(callback);
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (error || !this.writableFinished) this.decoder.destroy(error ?? undefined);
    callback(error);
  }
}

/** Check the immutable staged suffix from the first unused physical byte,
 * including later chunks the decoder may have consumed, before returning. */
export async function validateGzipContainerTail(filePath: string, consumed: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (!Number.isSafeInteger(consumed) || consumed <= 0 || consumed > size) {
      throw new ArchiveFormatError("invalid gzip consumed-input boundary");
    }
    if (consumed === size) return;
    const buffer = Buffer.allocUnsafe(65536);
    let position = consumed;
    while (position < size) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      signal?.throwIfAborted();
      if (bytesRead === 0) throw new ArchiveFormatError("truncated gzip container padding");
      if (buffer.subarray(0, bytesRead).some((byte) => byte !== 0)) {
        throw new ArchiveFormatError("nonzero gzip container padding");
      }
      position += bytesRead;
    }
  } finally { await handle.close(); }
}
