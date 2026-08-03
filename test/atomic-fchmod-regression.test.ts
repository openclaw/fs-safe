import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { itPosix, itWin32, useTempDirs } from "./helpers/vitest.js";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/atomic.js";

const { tempRoot } = useTempDirs();



async function runAsyncFallbackOrderProbe(root: string): Promise<{
  filePath: string;
  operations: string[];
}> {
  const filePath = path.join(root, "state.txt");
  const operations: string[] = [];
  const renameDenied = () => Object.assign(new Error("rename denied"), { code: "EPERM" });

  await replaceFileAtomic({
    filePath,
    content: "replacement",
    mode: 0o640,
    copyFallbackOnPermissionError: true,
    syncTempFile: true,
    fileSystem: {
      promises: {
        ...fs,
        rename: async () => { throw renameDenied(); },
        open: (async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args);
          if (String(args[0]) === filePath) {
            const chmod = handle.chmod.bind(handle);
            const sync = handle.sync.bind(handle);
            handle.chmod = async (mode) => {
              operations.push("chmod");
              await chmod(mode);
            };
            handle.sync = async () => {
              operations.push("sync");
              await sync();
            };
          }
          return handle;
        }) as typeof fs.open,
      },
    },
  });
  return { filePath, operations };
}

function runSyncFallbackOrderProbe(root: string): {
  destinationFds: Set<number>;
  filePath: string;
  operations: string[];
} {
  const filePath = path.join(root, "state.txt");
  const destinationFds = new Set<number>();
  const operations: string[] = [];
  const renameDenied = () => Object.assign(new Error("rename denied"), { code: "EPERM" });
  const fileSystem = {
    ...fsSync,
    renameSync: () => { throw renameDenied(); },
    openSync: ((candidate, flags, mode) => {
      const fd = fsSync.openSync(candidate, flags, mode);
      if (String(candidate) === filePath) destinationFds.add(fd);
      return fd;
    }) as typeof fsSync.openSync,
    fchmodSync: ((fd, mode) => {
      if (destinationFds.has(fd)) operations.push("chmod");
      fsSync.fchmodSync(fd, mode);
    }) as typeof fsSync.fchmodSync,
    fsyncSync: ((fd) => {
      if (destinationFds.has(fd)) operations.push("sync");
      fsSync.fsyncSync(fd);
    }) as typeof fsSync.fsyncSync,
    closeSync: ((fd) => {
      fsSync.closeSync(fd);
      destinationFds.delete(fd);
    }) as typeof fsSync.closeSync,
  };

  replaceFileAtomicSync({
    filePath,
    content: "replacement",
    mode: 0o640,
    copyFallbackOnPermissionError: true,
    syncTempFile: true,
    fileSystem,
  });
  return { destinationFds, filePath, operations };
}

describe("atomic descriptor modes", () => {
  itPosix("does not chmod an async destination swapped for a symlink after rename", async () => {
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
  });

  itPosix("does not chmod a sync destination swapped for a symlink after rename", async () => {
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
  });

  itPosix("applies exact async and sync modes through temp descriptors despite umask", async () => {
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
  });

  itPosix("keeps explicit and preserved modes exact across restrictive umasks", async () => {
    const root = await tempRoot("fs-safe-atomic-fchmod-umasks-");
    const previousUmask = process.umask();
    try {
      for (const mask of [0o000, 0o022, 0o077, 0o777]) {
        process.umask(mask);
        const suffix = mask.toString(8);
        const asyncPath = path.join(root, `async-${suffix}.txt`);
        const syncPath = path.join(root, `sync-${suffix}.txt`);
        const preservedPath = path.join(root, `preserved-${suffix}.txt`);
        const preservedSyncPath = path.join(root, `preserved-sync-${suffix}.txt`);
        const missingPath = path.join(root, `missing-${suffix}.txt`);
        const missingSyncPath = path.join(root, `missing-sync-${suffix}.txt`);
        await Promise.all([
          fs.writeFile(preservedPath, "old"),
          fs.writeFile(preservedSyncPath, "old"),
        ]);
        await Promise.all([
          fs.chmod(preservedPath, 0o651),
          fs.chmod(preservedSyncPath, 0o651),
        ]);

        await replaceFileAtomic({ filePath: asyncPath, content: "async", mode: 0o670 });
        replaceFileAtomicSync({ filePath: syncPath, content: "sync", mode: 0o670 });
        await replaceFileAtomic({
          filePath: preservedPath,
          content: "preserved",
          preserveExistingMode: true,
        });
        await replaceFileAtomic({
          filePath: missingPath,
          content: "missing",
          mode: 0o642,
          preserveExistingMode: true,
        });
        replaceFileAtomicSync({
          filePath: preservedSyncPath,
          content: "preserved",
          preserveExistingMode: true,
        });
        replaceFileAtomicSync({
          filePath: missingSyncPath,
          content: "missing",
          mode: 0o642,
          preserveExistingMode: true,
        });

        expect((await fs.stat(asyncPath)).mode & 0o777).toBe(0o670);
        expect(fsSync.statSync(syncPath).mode & 0o777).toBe(0o670);
        expect((await fs.stat(preservedPath)).mode & 0o777).toBe(0o651);
        expect((await fs.stat(missingPath)).mode & 0o777).toBe(0o642);
        expect(fsSync.statSync(preservedSyncPath).mode & 0o777).toBe(0o651);
        expect(fsSync.statSync(missingSyncPath).mode & 0o777).toBe(0o642);
      }
    } finally {
      process.umask(previousUmask);
    }
  });

  itPosix("preserves exact descriptor modes through async and sync copy fallback", async () => {
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
  });

  itPosix("applies and syncs the final copy-fallback mode before closing the destination", async () => {
    const root = await tempRoot("fs-safe-atomic-fchmod-fallback-order-");
    const { filePath, operations } = await runAsyncFallbackOrderProbe(root);

    expect(operations).toEqual(["chmod", "sync"]);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o640);
    expect(await fs.readFile(filePath, "utf8")).toBe("replacement");
  });

  itPosix("keeps synchronous copy-fallback chmod before the final destination sync", async () => {
    const root = await tempRoot("fs-safe-atomic-fchmod-fallback-order-sync-");
    const { destinationFds, filePath, operations } = runSyncFallbackOrderProbe(root);

    expect(operations).toEqual(["chmod", "sync"]);
    expect(fsSync.statSync(filePath).mode & 0o777).toBe(0o640);
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("replacement");
    expect(destinationFds.size).toBe(0);
  });

  itWin32("publishes and syncs async copy fallback without claiming POSIX mode enforcement", async () => {
    const root = await tempRoot("fs-safe-atomic-fchmod-fallback-order-win32-");
    const { filePath, operations } = await runAsyncFallbackOrderProbe(root);

    expect(operations).toEqual(["chmod", "sync"]);
    expect(await fs.readFile(filePath, "utf8")).toBe("replacement");
  });

  itWin32("publishes and syncs synchronous copy fallback without claiming POSIX mode enforcement", async () => {
    const root = await tempRoot("fs-safe-atomic-fchmod-fallback-order-sync-win32-");
    const { destinationFds, filePath, operations } = runSyncFallbackOrderProbe(root);

    expect(operations).toEqual(["chmod", "sync"]);
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("replacement");
    expect(destinationFds.size).toBe(0);
  });

  itPosix("restores bytes and mode and closes descriptors when fallback chmod fails", async () => {
    const root = await tempRoot("fs-safe-atomic-fchmod-restore-");
    const filePath = path.join(root, "state.txt");
    const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    await fs.writeFile(filePath, "original");
    await fs.chmod(filePath, 0o644);
    const descriptorsBefore = (await fs.readdir(descriptorDirectory)).length;
    let failMode = true;

    await expect(replaceFileAtomic({
      filePath,
      content: "replacement",
      mode: 0o600,
      copyFallbackOnPermissionError: true,
      copyFallbackRestore: "restore-original",
      maxRestoreBytes: 1024,
      fileSystem: {
        promises: {
          ...fs,
          rename: async () => {
            throw Object.assign(new Error("rename denied"), { code: "EPERM" });
          },
          open: (async (...args: Parameters<typeof fs.open>) => {
            const handle = await fs.open(...args);
            if (String(args[0]) === filePath) {
              const chmod = handle.chmod.bind(handle);
              handle.chmod = async (mode) => {
                if (failMode) {
                  failMode = false;
                  throw Object.assign(new Error("mode denied"), { code: "EPERM" });
                }
                await chmod(mode);
              };
            }
            return handle;
          }) as typeof fs.open,
        },
      },
    })).rejects.toMatchObject({
      code: "helper-failed",
      details: { cleanup: "restored" },
    });

    expect(await fs.readFile(filePath, "utf8")).toBe("original");
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o644);
    expect((await fs.readdir(root)).filter((entry) => entry.startsWith(".fs-safe-replace")))
      .toEqual([]);
    expect((await fs.readdir(descriptorDirectory)).length).toBe(descriptorsBefore);
  });

  itPosix("accepts node:fs injection with an explicit async mode", async () => {
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
  });

  it("fails closed before mutation when an injected sync filesystem cannot set an explicit mode", async () => {
    const root = await tempRoot("fs-safe-atomic-fchmod-missing-");
    const syncPath = path.join(root, "sync.txt");
    const syncDefaultPath = path.join(root, "sync-default.txt");
    const syncPreservePath = path.join(root, "sync-preserve.txt");
    const { fchmodSync: _fchmodSync, ...syncWithoutFchmod } = fsSync;

    expect(() => replaceFileAtomicSync({
      filePath: syncPath,
      content: "sync",
      mode: 0o600,
      fileSystem: syncWithoutFchmod,
    })).toThrow("fileSystem.fchmodSync is required");

    await expect(fs.access(syncPath)).rejects.toMatchObject({ code: "ENOENT" });

    expect(() => replaceFileAtomicSync({
      filePath: syncPreservePath,
      content: "sync",
      preserveExistingMode: true,
      fileSystem: syncWithoutFchmod,
    })).toThrow("fileSystem.fchmodSync is required");

    await expect(fs.access(syncPreservePath)).rejects.toMatchObject({ code: "ENOENT" });

    replaceFileAtomicSync({
      filePath: syncDefaultPath,
      content: "sync default",
      fileSystem: syncWithoutFchmod,
    });
    expect(fsSync.readFileSync(syncDefaultPath, "utf8")).toBe("sync default");
  });
});
