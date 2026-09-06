import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";

export async function syncFileBestEffort(handle: Pick<FileHandle, "sync">): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EPERM") throw error;
  }
}

export function syncFileBestEffortSync(
  fd: number,
  fsModule: Pick<typeof fs, "fsyncSync"> = fs,
): void {
  try {
    fsModule.fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EPERM") throw error;
  }
}
