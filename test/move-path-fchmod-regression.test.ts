import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movePathWithCopyFallback } from "../src/move-path.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe.runIf(process.platform !== "win32")("move staging descriptor modes", () => {
  it("does not redirect a staged file mode through a swapped symlink", async () => {
    const sourceDir = await tempRoot("fs-safe-move-file-source-");
    const targetDir = await tempRoot("fs-safe-move-file-target-");
    const victimDir = await tempRoot("fs-safe-move-file-victim-");
    const sourcePath = path.join(sourceDir, "source.txt");
    const targetPath = path.join(targetDir, "target.txt");
    const victimPath = path.join(victimDir, "victim.txt");
    await fs.writeFile(sourcePath, "source");
    await fs.chmod(sourcePath, 0o666);
    await fs.writeFile(victimPath, "victim");
    await fs.chmod(victimPath, 0o644);
    const swaps = await installStagingModeSwap({
      targetDir,
      victimPath,
      symlinkType: "file",
    });

    const previousUmask = process.umask(0o077);
    try {
      await movePathWithCopyFallback({
        from: sourcePath,
        sourceHardlinks: "reject",
        to: targetPath,
      });
    } finally {
      process.umask(previousUmask);
    }

    expect({
      publishedMode: (await fs.stat(targetPath)).mode & 0o777,
      swaps: swaps(),
      victimMode: (await fs.stat(victimPath)).mode & 0o777,
    }).toEqual({ publishedMode: 0o666, swaps: 1, victimMode: 0o644 });
  });

  it("does not redirect a staged directory mode through a swapped symlink", async () => {
    const sourceParent = await tempRoot("fs-safe-move-dir-source-");
    const targetDir = await tempRoot("fs-safe-move-dir-target-");
    const victimParent = await tempRoot("fs-safe-move-dir-victim-");
    const sourcePath = path.join(sourceParent, "source");
    const targetPath = path.join(targetDir, "target");
    const victimPath = path.join(victimParent, "victim");
    await fs.mkdir(sourcePath, { mode: 0o777 });
    await fs.chmod(sourcePath, 0o777);
    await fs.mkdir(victimPath, { mode: 0o755 });
    await fs.chmod(victimPath, 0o755);
    const swaps = await installStagingModeSwap({
      targetDir,
      victimPath,
      symlinkType: "dir",
    });

    const previousUmask = process.umask(0o077);
    try {
      await movePathWithCopyFallback({
        from: sourcePath,
        sourceHardlinks: "reject",
        to: targetPath,
      });
    } finally {
      process.umask(previousUmask);
    }

    expect({
      publishedMode: (await fs.stat(targetPath)).mode & 0o777,
      swaps: swaps(),
      victimMode: (await fs.stat(victimPath)).mode & 0o777,
    }).toEqual({ publishedMode: 0o777, swaps: 1, victimMode: 0o755 });
  });
});
