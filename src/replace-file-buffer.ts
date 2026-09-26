import type syncFs from "node:fs";
import type { FileHandle } from "node:fs/promises";

export async function writeAtomicDestination(
  handle: FileHandle,
  data: Buffer,
  beforeWrite?: () => Promise<void>,
  assertBeforeMutation?: () => void,
  onWriting?: () => void,
): Promise<void> {
  if (beforeWrite) await beforeWrite();
  assertBeforeMutation?.();
  await handle.truncate(0);
  onWriting?.();
  let written = 0;
  while (written < data.length) {
    if (beforeWrite) await beforeWrite();
    assertBeforeMutation?.();
    const result = await handle.write(data, written, data.length - written, written);
    if (result.bytesWritten === 0) throw new Error("Copy fallback write made no progress");
    written += result.bytesWritten;
  }
  if (beforeWrite) await beforeWrite();
  assertBeforeMutation?.();
  await handle.truncate(data.length);
}

export function writeAtomicDestinationSync(fsModule: Pick<typeof syncFs, "ftruncateSync" | "writeSync">, fd: number, data: Buffer, beforeWrite?: () => void, onWriting?: () => void): void {
  beforeWrite?.();
  fsModule.ftruncateSync(fd, 0);
  onWriting?.();
  let written = 0;
  while (written < data.length) {
    beforeWrite?.();
    const bytesWritten = fsModule.writeSync(fd, data, written, data.length - written, written);
    if (bytesWritten === 0) throw new Error("Copy fallback write made no progress");
    written += bytesWritten;
  }
  beforeWrite?.();
  fsModule.ftruncateSync(fd, data.length);
}
