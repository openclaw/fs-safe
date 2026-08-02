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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("atomic descriptor modes", () => {
  it.runIf(process.platform !== "win32")(
    "does not chmod an async destination swapped for a symlink after rename",
    async () => {
      const root = await tempRoot("fs-safe-atomic-chmod-race-");
      const filePath = path.join(root, "state.txt");
      const victimPath = path.join(root, "victim.txt");
      const chmodPaths: string[] = [];
      let publishedMode: number | undefined;
      await fs.writeFile(victimPath, "victim", { mode: 0o644 });
      await fs.chmod(victimPath, 0o644);

      const previousUmask = process.umask(0o077);
      try {
        await replaceFileAtomic({
          filePath,
          content: "new",
          mode: 0o600,
          fileSystem: {
            promises: {
              ...fs,
              chmod: async (candidate, mode) => {
                chmodPaths.push(String(candidate));
                await fs.chmod(candidate, mode);
              },
              rename: async (source, destination) => {
                await fs.rename(source, destination);
                publishedMode = (await fs.stat(destination)).mode & 0o777;
                await fs.unlink(destination);
                await fs.symlink(victimPath, destination);
              },
            },
          },
        });
      } finally {
        process.umask(previousUmask);
      }

      expect({
        chmodPaths,
        publishedMode,
        victimMode: (await fs.stat(victimPath)).mode & 0o777,
      }).toEqual({ chmodPaths: [], publishedMode: 0o600, victimMode: 0o644 });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not chmod a sync destination swapped for a symlink after rename",
    async () => {
      const root = await tempRoot("fs-safe-atomic-chmod-race-sync-");
      const filePath = path.join(root, "state.txt");
      const victimPath = path.join(root, "victim.txt");
      const chmodPaths: string[] = [];
      let publishedMode: number | undefined;
      await fs.writeFile(victimPath, "victim", { mode: 0o644 });
      await fs.chmod(victimPath, 0o644);
      const fileSystem = {
        ...fsSync,
        chmodSync: ((candidate: fsSync.PathLike, mode: fsSync.Mode) => {
          chmodPaths.push(String(candidate));
          fsSync.chmodSync(candidate, mode);
        }) as typeof fsSync.chmodSync,
        renameSync: ((source: fsSync.PathLike, destination: fsSync.PathLike) => {
          fsSync.renameSync(source, destination);
          publishedMode = fsSync.statSync(destination).mode & 0o777;
          fsSync.unlinkSync(destination);
          fsSync.symlinkSync(victimPath, destination);
        }) as typeof fsSync.renameSync,
      };

      const previousUmask = process.umask(0o077);
      try {
        replaceFileAtomicSync({ filePath, content: "new", mode: 0o600, fileSystem });
      } finally {
        process.umask(previousUmask);
      }

      expect({
        chmodPaths,
        publishedMode,
        victimMode: fsSync.statSync(victimPath).mode & 0o777,
      }).toEqual({ chmodPaths: [], publishedMode: 0o600, victimMode: 0o644 });
    },
  );

  it.runIf(process.platform !== "win32")(
    "applies exact async and sync modes through temp descriptors despite umask",
    async () => {
      const root = await tempRoot("fs-safe-atomic-fchmod-mode-");
      const asyncPath = path.join(root, "async.txt");
      const syncPath = path.join(root, "sync.txt");

      const previousUmask = process.umask(0o077);
      try {
        await replaceFileAtomic({ filePath: asyncPath, content: "async", mode: 0o666 });
        replaceFileAtomicSync({ filePath: syncPath, content: "sync", mode: 0o666 });
      } finally {
        process.umask(previousUmask);
      }

      expect((await fs.stat(asyncPath)).mode & 0o777).toBe(0o666);
      expect(fsSync.statSync(syncPath).mode & 0o777).toBe(0o666);
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves exact descriptor modes through async and sync copy fallback",
    async () => {
      const root = await tempRoot("fs-safe-atomic-fchmod-fallback-");
      const asyncPath = path.join(root, "async.txt");
      const syncPath = path.join(root, "sync.txt");
      const renameDenied = () => Object.assign(new Error("rename denied"), { code: "EPERM" });

      const previousUmask = process.umask(0o077);
      try {
        await replaceFileAtomic({
          filePath: asyncPath,
          content: "async",
          mode: 0o666,
          copyFallbackOnPermissionError: true,
          fileSystem: {
            promises: {
              ...fs,
              rename: async () => { throw renameDenied(); },
            },
          },
        });
        replaceFileAtomicSync({
          filePath: syncPath,
          content: "sync",
          mode: 0o666,
          copyFallbackOnPermissionError: true,
          fileSystem: {
            ...fsSync,
            renameSync: () => { throw renameDenied(); },
          },
        });
      } finally {
        process.umask(previousUmask);
      }

      expect((await fs.stat(asyncPath)).mode & 0o777).toBe(0o666);
      expect(fsSync.statSync(syncPath).mode & 0o777).toBe(0o666);
    },
  );

  it.runIf(process.platform !== "win32")(
    "accepts node:fs injection with an explicit async mode",
    async () => {
      const root = await tempRoot("fs-safe-atomic-node-fs-");
      const filePath = path.join(root, "state.txt");
      const previousUmask = process.umask(0o077);
      try {
        await replaceFileAtomic({
          filePath,
          content: "injected",
          mode: 0o666,
          fileSystem: fsSync,
        });
      } finally {
        process.umask(previousUmask);
      }

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("injected");
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o666);
    },
  );

  it("fails closed before mutation when an injected sync filesystem cannot set an explicit mode", async () => {
    const root = await tempRoot("fs-safe-atomic-fchmod-missing-");
    const syncPath = path.join(root, "sync.txt");
    const syncDefaultPath = path.join(root, "sync-default.txt");
    const { fchmodSync: _fchmodSync, ...syncWithoutFchmod } = fsSync;

    expect(() => replaceFileAtomicSync({
      filePath: syncPath,
      content: "sync",
      mode: 0o600,
      fileSystem: syncWithoutFchmod,
    })).toThrow("fileSystem.fchmodSync is required");

    await expect(fs.access(syncPath)).rejects.toMatchObject({ code: "ENOENT" });

    replaceFileAtomicSync({
      filePath: syncDefaultPath,
      content: "sync default",
      fileSystem: syncWithoutFchmod,
    });
    expect(fsSync.readFileSync(syncDefaultPath, "utf8")).toBe("sync default");
  });
});
