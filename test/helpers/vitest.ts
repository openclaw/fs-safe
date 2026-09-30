import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, it, vi } from "vitest";

export const itPosix = it.runIf(process.platform !== "win32");
export const itWin32 = it.runIf(process.platform === "win32");
export const itDarwin = it.runIf(process.platform === "darwin");

// Hosted Windows runners stall ordinary filesystem calls for seconds. Across 108
// CI jobs, the slowest run of any sub-second test was 7.1 s. Call at file scope
// in real-I/O suites whose tests are fast; other platforms keep the 5 s default.
export function allowWindowsFilesystemStalls(): void {
  if (process.platform === "win32") vi.setConfig({ testTimeout: 15_000 });
}

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
