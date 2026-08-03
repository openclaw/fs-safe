import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "vitest";

export const itPosix = it.runIf(process.platform !== "win32");
export const itWin32 = it.runIf(process.platform === "win32");
export const itDarwin = it.runIf(process.platform === "darwin");

export type TempDirsFixture = {
  tempDirs: string[];
  tempRoot(prefix: string): Promise<string>;
};

function useTempDirsFixture(realpath: boolean): TempDirsFixture {
  const tempDirs: string[] = [];

  // Register first: Vitest runs afterEach hooks in reverse order, so local mock
  // restoration runs before this cleanup reaches the real filesystem.
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })),
    );
  });

  return {
    tempDirs,
    async tempRoot(prefix: string): Promise<string> {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      tempDirs.push(directory);
      return realpath ? await fs.realpath(directory) : directory;
    },
  };
}

export function useTempDirs(): TempDirsFixture {
  return useTempDirsFixture(false);
}

export function useRealTempDirs(): TempDirsFixture {
  return useTempDirsFixture(true);
}
