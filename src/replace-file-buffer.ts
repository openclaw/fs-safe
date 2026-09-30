import type { AtomicFile, Procedure } from "./atomic-io.js";
import type { AtomicDestination } from "./replace-file-destination.js";

export function* writeAtomicDestination(
  file: AtomicFile,
  data: Buffer,
  destination?: AtomicDestination,
  restore = false,
): Procedure<void> {
  if (destination) yield* destination.beforeWrite(restore);
  yield* file.truncate(0);
  destination?.writing();
  let written = 0;
  while (written < data.length) {
    if (destination) yield* destination.beforeWrite(restore);
    let result = file.write(data, written, data.length - written, written);
    if (file.io.asynchronous) {
      const completed = (yield result) as { bytesWritten: number };
      if (completed.bytesWritten === 0) throw new Error("Copy fallback write made no progress");
      result = completed.bytesWritten;
    }
    written += result as number;
  }
  if (destination) yield* destination.beforeWrite(restore);
  yield* file.truncate(data.length);
}
