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
    const bytesWritten = yield* file.write(data, written, data.length - written, written);
    written += bytesWritten;
  }
  if (destination) yield* destination.beforeWrite(restore);
  yield* file.truncate(data.length);
}
