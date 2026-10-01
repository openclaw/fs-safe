import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import { movePathWithCopyFallback } from "../src/move-path.js";

const { tempRoot } = useTempDirs();


async function installStagingModeSwap(params: {
  targetDir: string;
  victimPath: string;
  symlinkType: "dir" | "file";
}): Promise<() => number> {
  const probePath = path.join(params.targetDir, "handle-probe");
  const probe = await fs.open(probePath, "w");
  const handlePrototype = Object.getPrototypeOf(probe) as {
    chmod(mode: number): Promise<void>;
  };
  const realHandleChmod = handlePrototype.chmod;
  await probe.close();
  await fs.unlink(probePath);

  const realPathChmod = fs.chmod;
  let swaps = 0;

  const findStagingPath = async (): Promise<string> => {
    const name = (await fs.readdir(params.targetDir)).find(
      (entry) => entry.startsWith(".fs-safe-move-") && entry.endsWith(".tmp"),
    );
    if (!name) {
      throw new Error("move staging entry not found");
    }
    return path.join(params.targetDir, name);
  };

  const swapAround = async (stagingPath: string, applyMode: () => Promise<void>) => {
    swaps += 1;
    const parkedPath = `${stagingPath}.parked`;
    await fs.rename(stagingPath, parkedPath);
    await fs.symlink(params.victimPath, stagingPath, params.symlinkType);
    try {
      await applyMode();
    } finally {
      await fs.unlink(stagingPath);
      await fs.rename(parkedPath, stagingPath);
    }
  };

  vi.spyOn(fs, "chmod").mockImplementation(async (candidate, mode) => {
    const candidatePath = String(candidate);
    if (!path.basename(candidatePath).startsWith(".fs-safe-move-")) {
      await realPathChmod(candidate, mode);
      return;
    }
    await swapAround(candidatePath, async () => await realPathChmod(candidate, mode));
  });
  vi.spyOn(handlePrototype, "chmod").mockImplementation(async function (mode) {
    const stagingPath = await findStagingPath();
    await swapAround(stagingPath, async () => await realHandleChmod.call(this, mode));
  });

  return () => swaps;
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe.runIf(process.platform !== "win32")("move staging descriptor modes", () => {
  it("preserves exact file modes across all umasks and directory modes while reopenable", async () => {
    const root = await tempRoot("fs-safe-move-mode-umasks-");
    const previousUmask = process.umask();
    try {
      for (const mask of [0o000, 0o022, 0o077, 0o777]) {
        process.umask(mask);
        const suffix = mask.toString(8);
        const sourceFile = path.join(root, `source-${suffix}.txt`);
        const targetFile = path.join(root, `target-${suffix}.txt`);
        const sourceDir = path.join(root, `source-${suffix}`);
        const targetDir = path.join(root, `target-${suffix}`);
        await fs.writeFile(sourceFile, "source");
        await fs.chmod(sourceFile, 0o666);
        await fs.mkdir(sourceDir);
        await fs.chmod(sourceDir, 0o751);

        await movePathWithCopyFallback({
          from: sourceFile,
          sourceHardlinks: "reject",
          to: targetFile,
        });
        if (mask !== 0o777) {
          await movePathWithCopyFallback({
            from: sourceDir,
            sourceHardlinks: "reject",
            to: targetDir,
          });
        }

        expect((await fs.stat(targetFile)).mode & 0o777).toBe(0o666);
        if (mask !== 0o777) {
          expect((await fs.stat(targetDir)).mode & 0o777).toBe(0o751);
        }
      }
    } finally {
      process.umask(previousUmask);
    }
  });

  it.each([
    {
      kind: "file", symlinkType: "file", sourceMode: 0o666, victimMode: 0o644,
      create: async (candidate: string, content: string, _mode: number) => { await fs.writeFile(candidate, content); },
    },
    {
      kind: "directory", symlinkType: "dir", sourceMode: 0o777, victimMode: 0o755,
      create: async (candidate: string, _content: string, mode: number) => { await fs.mkdir(candidate, { mode }); },
    },
  ] as const)("does not redirect a staged $kind mode through a swapped symlink", async ({ kind, symlinkType, sourceMode, victimMode, create }) => {
    const sourceDir = await tempRoot(`fs-safe-move-${kind}-source-`);
    const targetDir = await tempRoot(`fs-safe-move-${kind}-target-`);
    const victimDir = await tempRoot(`fs-safe-move-${kind}-victim-`);
    const sourcePath = path.join(sourceDir, "source");
    const targetPath = path.join(targetDir, "target");
    const victimPath = path.join(victimDir, "victim");
    await create(sourcePath, "source", sourceMode);
    await fs.chmod(sourcePath, sourceMode);
    await create(victimPath, "victim", victimMode);
    await fs.chmod(victimPath, victimMode);
    const swaps = await installStagingModeSwap({ targetDir, victimPath, symlinkType });

    const previousUmask = process.umask(0o077);
    try {
      await movePathWithCopyFallback({ from: sourcePath, sourceHardlinks: "reject", to: targetPath });
    } finally {
      process.umask(previousUmask);
    }

    expect({
      publishedMode: (await fs.stat(targetPath)).mode & 0o777,
      swaps: swaps(),
      victimMode: (await fs.stat(victimPath)).mode & 0o777,
    }).toEqual({ publishedMode: sourceMode, swaps: 1, victimMode });
  });
});
