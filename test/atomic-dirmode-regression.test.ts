import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isDirectoryOpen(flags: string | number): boolean {
  return typeof flags === "number" && (flags & fsSync.constants.O_DIRECTORY) !== 0;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("atomic parent-directory descriptor modes", () => {
  it.runIf(process.platform !== "win32")(
    "keeps an async directory mode bound to the opened directory across a pathname swap",
    async () => {
      const root = await tempRoot("fs-safe-atomic-dirmode-race-");
      const targetDir = path.join(root, "target");
      const displacedDir = path.join(root, "displaced");
      const victimDir = path.join(root, "victim");
      const filePath = path.join(targetDir, "state.txt");
      await Promise.all([fs.mkdir(targetDir), fs.mkdir(victimDir)]);
      await Promise.all([fs.chmod(targetDir, 0o755), fs.chmod(victimDir, 0o755)]);
      let swapped = false;

      const swap = async () => {
        await fs.rename(targetDir, displacedDir);
        await fs.symlink(victimDir, targetDir, "dir");
        swapped = true;
      };
      const restore = async () => {
        await fs.unlink(targetDir);
        await fs.rename(displacedDir, targetDir);
        swapped = false;
      };
      const injectedPromises = {
        ...fs,
        chmod: async (candidate: fsSync.PathLike, mode: fsSync.Mode) => {
          if (!swapped && path.resolve(String(candidate)) === targetDir) {
            await swap();
          }
          await fs.chmod(candidate, mode);
        },
        open: (async (...args: Parameters<typeof fs.open>) => {
          const [candidate, flags] = args;
          if (swapped && flags === "wx") {
            await restore();
          }
          const handle = await fs.open(...args);
          if (
            !swapped &&
            path.resolve(String(candidate)) === targetDir &&
            isDirectoryOpen(flags)
          ) {
            await swap();
          }
          return handle;
        }) as typeof fs.open,
      };

      const previousUmask = process.umask(0o077);
      try {
        await replaceFileAtomic({
          filePath,
          content: "async",
          dirMode: 0o751,
          fileSystem: { promises: injectedPromises },
        });
      } finally {
        process.umask(previousUmask);
      }

      expect({
        targetMode: (await fs.stat(targetDir)).mode & 0o777,
        victimMode: (await fs.stat(victimDir)).mode & 0o777,
        content: await fs.readFile(filePath, "utf8"),
      }).toEqual({ targetMode: 0o751, victimMode: 0o755, content: "async" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a sync directory mode bound to the opened directory across a pathname swap",
    async () => {
      const root = await tempRoot("fs-safe-atomic-dirmode-race-sync-");
      const targetDir = path.join(root, "target");
      const displacedDir = path.join(root, "displaced");
      const victimDir = path.join(root, "victim");
      const filePath = path.join(targetDir, "state.txt");
      fsSync.mkdirSync(targetDir);
      fsSync.mkdirSync(victimDir);
      fsSync.chmodSync(targetDir, 0o755);
      fsSync.chmodSync(victimDir, 0o755);
      let swapped = false;

      const swap = () => {
        fsSync.renameSync(targetDir, displacedDir);
        fsSync.symlinkSync(victimDir, targetDir, "dir");
        swapped = true;
      };
      const restore = () => {
        fsSync.unlinkSync(targetDir);
        fsSync.renameSync(displacedDir, targetDir);
        swapped = false;
      };
      const injectedFileSystem = {
        ...fsSync,
        chmodSync: ((candidate: fsSync.PathLike, mode: fsSync.Mode) => {
          if (!swapped && path.resolve(String(candidate)) === targetDir) {
            swap();
          }
          fsSync.chmodSync(candidate, mode);
        }) as typeof fsSync.chmodSync,
        openSync: ((candidate, flags, mode) => {
          if (swapped && flags === "wx") {
            restore();
          }
          const fd = fsSync.openSync(candidate, flags, mode);
          if (
            !swapped &&
            path.resolve(String(candidate)) === targetDir &&
            isDirectoryOpen(flags)
          ) {
            swap();
          }
          return fd;
        }) as typeof fsSync.openSync,
      };

      const previousUmask = process.umask(0o077);
      try {
        replaceFileAtomicSync({
          filePath,
          content: "sync",
          dirMode: 0o751,
          fileSystem: injectedFileSystem,
        });
      } finally {
        process.umask(previousUmask);
      }

      expect({
        targetMode: fsSync.statSync(targetDir).mode & 0o777,
        victimMode: fsSync.statSync(victimDir).mode & 0o777,
        content: fsSync.readFileSync(filePath, "utf8"),
      }).toEqual({ targetMode: 0o751, victimMode: 0o755, content: "sync" });
    },
  );

  it("accepts plain node:fs injection with explicit async and sync dirMode", async () => {
    const root = await tempRoot("fs-safe-atomic-dirmode-node-fs-");
    const asyncDir = path.join(root, "async");
    const syncDir = path.join(root, "sync");
    const asyncPath = path.join(asyncDir, "state.txt");
    const syncPath = path.join(syncDir, "state.txt");

    const previousUmask = process.umask(0o077);
    try {
      await replaceFileAtomic({
        filePath: asyncPath,
        content: "async",
        dirMode: 0o751,
        fileSystem: fsSync,
      });
      replaceFileAtomicSync({
        filePath: syncPath,
        content: "sync",
        dirMode: 0o751,
        fileSystem: fsSync,
      });
    } finally {
      process.umask(previousUmask);
    }

    await expect(fs.readFile(asyncPath, "utf8")).resolves.toBe("async");
    expect(fsSync.readFileSync(syncPath, "utf8")).toBe("sync");
    if (process.platform !== "win32") {
      expect((await fs.stat(asyncDir)).mode & 0o777).toBe(0o751);
      expect(fsSync.statSync(syncDir).mode & 0o777).toBe(0o751);
    }
  });

  it.runIf(process.platform !== "win32")(
    "fails before mutation when an injected sync filesystem cannot honor dirMode",
    async () => {
      const root = await tempRoot("fs-safe-atomic-dirmode-fchmod-missing-");
      const filePath = path.join(root, "missing", "state.txt");
      const { fchmodSync: _fchmodSync, ...syncWithoutFchmod } = fsSync;

      expect(() => replaceFileAtomicSync({
        filePath,
        content: "sync",
        dirMode: 0o751,
        fileSystem: syncWithoutFchmod,
      })).toThrow("fileSystem.fchmodSync is required");
      await expect(fs.access(path.dirname(filePath))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked parent with a sync adapter that omits fchmodSync",
    async () => {
      const root = await tempRoot("fs-safe-atomic-dirmode-symlink-");
      const outside = await tempRoot("fs-safe-atomic-dirmode-outside-");
      const linkedDir = path.join(root, "linked");
      const filePath = path.join(linkedDir, "state.txt");
      const { fchmodSync: _fchmodSync, ...syncWithoutFchmod } = fsSync;
      await fs.symlink(outside, linkedDir, "dir");

      expect(() => replaceFileAtomicSync({
        filePath,
        content: "must not escape",
        fileSystem: syncWithoutFchmod,
      })).toThrow("Atomic replace parent must be a real directory");

      await expect(fs.access(path.join(outside, "state.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});
