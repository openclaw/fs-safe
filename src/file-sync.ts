import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";

export function syncFile(handle: Pick<FileHandle, "sync"> | number): Promise<void> {
  return typeof handle === "number"
    ? new Promise((resolve, reject) => fs.fsync(handle, error => error ? reject(error) : resolve()))
    : handle.sync();
}

export async function syncFileBestEffort(handle: Pick<FileHandle, "sync"> | number): Promise<void> {
  try {
    await syncFile(handle);
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
