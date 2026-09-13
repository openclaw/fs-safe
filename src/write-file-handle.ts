import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";

const WRITE_CHUNK_BYTES = 512 * 1024;

export async function writeAllToFile(
  target: FileHandle | number,
  data: string | Uint8Array,
  options: { encoding?: BufferEncoding; assertBeforeMutation?: () => void } = {},
): Promise<void> {
  const buffer = typeof data === "string" ? Buffer.from(data, options.encoding ?? "utf8") : data;
  let offset = 0;
  while (offset < buffer.byteLength) {
    const length = Math.min(WRITE_CHUNK_BYTES, buffer.byteLength - offset);
    options.assertBeforeMutation?.();
    const written = typeof target === "number"
      ? await new Promise<number>((resolve, reject) => {
        fs.write(target, buffer, offset, length, null, (error, bytesWritten) => {
          if (error) reject(error);
          else resolve(bytesWritten);
        });
      })
      : (await target.write(buffer, offset, length, null)).bytesWritten;
    if (written <= 0) {
      throw new FsSafeError("helper-failed", "file write made no progress");
    }
    offset += written;
  }
}
