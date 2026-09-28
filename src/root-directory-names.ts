import { isUtf8 } from "node:buffer";
import type { Dir } from "node:fs";
import fs from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { FsSafeError } from "./errors.js";

export function directoryEntryName(bytes: Buffer): string {
  if (!isUtf8(bytes)) {
    throw new FsSafeError("invalid-path", "directory entry name is not valid UTF-8");
  }
  return bytes.toString("utf8");
}

export async function readDirectoryEntryName(handle: Dir): Promise<string | undefined> {
  const entry = await handle.read();
  // Bun returns the raw Buffer directly; Node returns a Dirent whose name is a Buffer.
  // Node's Dir types still declare only string names.
  return entry === null ? undefined
    : directoryEntryName(Buffer.isBuffer(entry) ? entry : entry.name as unknown as Buffer);
}

export function openDirectoryNames(directory: string): Promise<Dir> {
  return fs.opendir(directory, { bufferSize: 1, encoding: "buffer" as BufferEncoding });
}

/** Read only the admitted prefix; no caller code runs inside a name batch. */
export async function readDirectoryNamePrefix(
  handle: Dir,
  maxNames: number,
  assertCurrent: () => Promise<void>,
): Promise<string[]> {
  const names: string[] = [];
  const asynchronous = typeof process.versions.bun === "string";
  while (names.length <= maxNames) {
    await assertCurrent();
    let ended = false;
    for (let count = 0; count < 32 && names.length <= maxNames; count++) {
      // Bun's Dir.readSync eagerly enumerates the directory. Keep its async
      // reader so that runtime limitation does not also block the event loop.
      const entry = asynchronous ? await handle.read() : handle.readSync();
      if (entry === null) { ended = true; break; }
      names.push(directoryEntryName(Buffer.isBuffer(entry) ? entry : entry.name as unknown as Buffer));
    }
    await assertCurrent();
    if (ended || names.length > maxNames) break;
    await yieldToEventLoop();
  }
  return names;
}
