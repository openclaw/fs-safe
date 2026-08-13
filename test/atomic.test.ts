import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectFsSafeError, expectFsSafeErrorSync } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  replaceDirectoryAtomic,
  replaceFileAtomic,
  replaceFileAtomicSync,
} from "../src/atomic.js";
import {
  __cleanupRegisteredTempPathsForTest,
  __cleanupRegisteredTempPathForTest,
  registerTempPathForExit,
} from "../src/temp-cleanup.js";

const { tempRoot } = useTempDirs();



describe("atomic helpers", () => {
  it("replaces a file through a sibling temp path", async () => {
    const root = await tempRoot("fs-safe-atomic-");
    const filePath = path.join(root, "nested", "state.txt");
    let observedTempPath: string | undefined;

    const result = await replaceFileAtomic({
      filePath,
      content: "new",
      syncTempFile: true,
      syncParentDir: true,
      beforeRename: async ({ tempPath }) => {
        observedTempPath = tempPath;
        await expect(fs.readFile(tempPath, "utf8")).resolves.toBe("new");
      },
    });

    expect(result).toEqual({ method: "rename" });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("new");
    await expect(fs.stat(observedTempPath ?? "")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent replacements for the same target", async () => {
    const root = await tempRoot("fs-safe-atomic-queue-");
    const filePath = path.join(root, "state.txt");
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = replaceFileAtomic({
      filePath,
      content: "first",
      beforeRename: async () => {
        events.push("first-before");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        events.push("first-release");
      },
    });
    while (!releaseFirst) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const second = replaceFileAtomic({
      filePath,
      content: "second",
      beforeRename: async () => {
        events.push("second-before");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["first-before"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(["first-before", "first-release", "second-before"]);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("second");
  });

  it("registers temp paths for best-effort exit cleanup", async () => {
    const root = await tempRoot("fs-safe-temp-cleanup-");
    const tempPath = path.join(root, "leftover.tmp");
    await fs.writeFile(tempPath, "temp", "utf8");
    const unregister = registerTempPathForExit(tempPath);

    __cleanupRegisteredTempPathForTest(tempPath);

    await expect(fs.access(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
    unregister();
  });

  it("cleans registered temp directories and ignores missing entries", async () => {
    const root = await tempRoot("fs-safe-temp-cleanup-dir-");
    const tempDir = path.join(root, "leftover");
    await fs.mkdir(tempDir);
    await fs.writeFile(path.join(tempDir, "file.txt"), "temp", "utf8");
    registerTempPathForExit(tempDir, { recursive: true });
    registerTempPathForExit(path.join(root, "missing.tmp"));

    __cleanupRegisteredTempPathsForTest();

    await expect(fs.access(tempDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves registered temp paths when Windows identity is unknown", async () => {
    const root = await tempRoot("fs-safe-temp-cleanup-unknown-");
    const tempPath = path.join(root, "leftover.tmp");
    await fs.writeFile(tempPath, "replacement", "utf8");
    const identity = await fs.lstat(tempPath);
    registerTempPathForExit(tempPath, {
      identity: { dev: identity.dev, ino: 0 },
    });
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    try {
      __cleanupRegisteredTempPathForTest(tempPath);
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor!);
    }

    await expect(fs.readFile(tempPath, "utf8")).resolves.toBe("replacement");
  });

  it("uses the permission-error copy fallback when requested", async () => {
    const root = await tempRoot("fs-safe-atomic-");
    const filePath = path.join(root, "state.txt");
    await fs.writeFile(filePath, "old", "utf8");

    const result = await replaceFileAtomic({
      filePath,
      content: "new",
      copyFallbackOnPermissionError: true,
      fileSystem: {
        promises: {
          ...fs,
          rename: async () => {
            const error = new Error("rename denied") as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          },
        },
      },
    });

    expect(result).toEqual({ method: "copy-fallback" });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("new");
  });

  itPosix("rejects a hardlinked destination from its pinned descriptor", async () => {
    const root = await tempRoot("fs-safe-atomic-hardlink-");
    const filePath = path.join(root, "state.txt");
    const otherPath = path.join(root, "other.txt");
    await fs.writeFile(filePath, "old", "utf8");
    await fs.link(filePath, otherPath);

    await expectFsSafeError(replaceFileAtomic({
        filePath,
        content: "new",
        destinationHardlinks: "reject",
        fileSystem: {
          promises: {
            ...fs,
            lstat: async (candidate) => {
              const stat = await fs.lstat(candidate);
              return candidate === filePath
                ? new Proxy(stat, { get: (target, property) => property === "nlink" ? 1 : Reflect.get(target, property) })
                : stat;
            },
          },
        },
      }), "hardlink");

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("old");
    await expect(fs.readFile(otherPath, "utf8")).resolves.toBe("old");
  });

  itPosix("rejects a hardlinked destination in the synchronous variant", async () => {
    const root = await tempRoot("fs-safe-atomic-hardlink-sync-");
    const filePath = path.join(root, "state.txt");
    const otherPath = path.join(root, "other.txt");
    await fs.writeFile(filePath, "old", "utf8");
    await fs.link(filePath, otherPath);

    expectFsSafeErrorSync(() =>
      replaceFileAtomicSync({
        filePath,
        content: "new",
        destinationHardlinks: "reject",
      }), "hardlink");
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("old");
    expect(fsSync.readFileSync(otherPath, "utf8")).toBe("old");
  });

  it("restores a destination after a torn copy-fallback write", async () => {
    const root = await tempRoot("fs-safe-atomic-restore-");
    const filePath = path.join(root, "state.txt");
    await fs.writeFile(filePath, "original", "utf8");
    let replacementWrites = 0;
    let syncs = 0;
    const open: typeof fs.open = async (candidate, flags, mode) => {
      const handle = await fs.open(candidate, flags, mode);
      if (candidate !== filePath || typeof flags !== "number" || !(flags & fsSync.constants.O_RDWR)) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "write") {
            return async (buffer: Buffer, offset: number, length: number, position: number) => {
              replacementWrites += 1;
              if (replacementWrites === 1) {
                await target.write(buffer, offset, 2, position);
                throw Object.assign(new Error("simulated torn write"), { code: "EIO" });
              }
              return await target.write(buffer, offset, length, position);
            };
          }
          if (property === "sync") {
            return async () => {
              syncs += 1;
              await target.sync();
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as FileHandle;
    };

    await expect(
      replaceFileAtomic({
        filePath,
        content: "replacement",
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 1024,
        fileSystem: {
          promises: {
            ...fs,
            open,
            rename: async () => {
              throw Object.assign(new Error("rename denied"), { code: "EPERM" });
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "helper-failed",
      details: { cleanup: "restored" },
    });

    expect(syncs).toBe(1);
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("original");
  });

  it("reports a restore-failed double fault", async () => {
    const root = await tempRoot("fs-safe-atomic-restore-failed-");
    const filePath = path.join(root, "state.txt");
    await fs.writeFile(filePath, "original", "utf8");
    let writes = 0;
    const open: typeof fs.open = async (candidate, flags, mode) => {
      const handle = await fs.open(candidate, flags, mode);
      if (candidate !== filePath || typeof flags !== "number" || !(flags & fsSync.constants.O_RDWR)) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "write") {
            return async (buffer: Buffer, offset: number, _length: number, position: number) => {
              writes += 1;
              await target.write(buffer, offset, writes === 1 ? 2 : 1, position);
              throw Object.assign(new Error(writes === 1 ? "write failed" : "restore failed"), {
                code: "EIO",
              });
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as FileHandle;
    };

    await expect(
      replaceFileAtomic({
        filePath,
        content: "replacement",
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 1024,
        fileSystem: {
          promises: {
            ...fs,
            open,
            rename: async () => {
              throw Object.assign(new Error("rename denied"), { code: "EPERM" });
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "helper-failed",
      details: { cleanup: "restore-failed" },
      cause: expect.any(AggregateError),
    });
  });

  it("refuses an oversized restore snapshot before modifying the destination", async () => {
    const root = await tempRoot("fs-safe-atomic-restore-limit-");
    const filePath = path.join(root, "state.txt");
    await fs.writeFile(filePath, "original", "utf8");

    await expectFsSafeError(replaceFileAtomic({
        filePath,
        content: "new",
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 3,
        fileSystem: {
          promises: {
            ...fs,
            rename: async () => {
              throw Object.assign(new Error("rename denied"), { code: "EPERM" });
            },
          },
        },
      }), "too-large");

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("original");
  });

  it("restores a torn synchronous copy-fallback write through the pinned fd", async () => {
    const root = await tempRoot("fs-safe-atomic-restore-sync-");
    const filePath = path.join(root, "state.txt");
    await fs.writeFile(filePath, "original", "utf8");
    let destinationFd: number | undefined;
    let writes = 0;
    const fileSystem = {
      ...fsSync,
      renameSync: () => {
        throw Object.assign(new Error("rename denied"), { code: "EPERM" });
      },
      openSync: ((candidate: fsSync.PathLike, flags: fsSync.OpenMode, mode?: fsSync.Mode) => {
        const fd = fsSync.openSync(candidate, flags, mode);
        if (candidate === filePath && typeof flags === "number" && (flags & fsSync.constants.O_RDWR)) {
          destinationFd = fd;
        }
        return fd;
      }) as typeof fsSync.openSync,
      writeSync: ((fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
        if (fd === destinationFd) {
          writes += 1;
          if (writes === 1) {
            fsSync.writeSync(fd, buffer, offset, 2, position);
            throw Object.assign(new Error("simulated torn write"), { code: "EIO" });
          }
        }
        return fsSync.writeSync(fd, buffer, offset, length, position);
      }) as typeof fsSync.writeSync,
    };

    expect(() =>
      replaceFileAtomicSync({
        filePath,
        content: "replacement",
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 1024,
        fileSystem,
      }),
    ).toThrow(expect.objectContaining({
      code: "helper-failed",
      details: { cleanup: "restored" },
    }));
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("original");
  });

  itPosix("does not copy fallback through destination symlinks", async () => {
    const root = await tempRoot("fs-safe-atomic-link-");
    const filePath = path.join(root, "state.txt");
    const outsidePath = path.join(root, "outside.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    await fs.symlink(outsidePath, filePath);

    await expect(
      replaceFileAtomic({
        filePath,
        content: "new",
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 1024,
        fileSystem: {
          promises: {
            ...fs,
            rename: async () => {
              const error = new Error("rename denied") as NodeJS.ErrnoException;
              error.code = "EPERM";
              throw error;
            },
          },
        },
      }),
    ).rejects.toThrow("Refusing copy fallback through symlink destination");

    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
    expect((await fs.lstat(filePath)).isSymbolicLink()).toBe(true);
    expect((await fs.readdir(root)).filter((entry) => entry.startsWith(".fs-safe-replace")))
      .toEqual([]);
  });

  itPosix("does not sync-copy fallback through destination symlinks", async () => {
    const root = await tempRoot("fs-safe-atomic-link-sync-");
    const filePath = path.join(root, "state.txt");
    const outsidePath = path.join(root, "outside.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    await fs.symlink(outsidePath, filePath);

    expect(() =>
      replaceFileAtomicSync({
        filePath,
        content: "new",
        copyFallbackOnPermissionError: true,
        copyFallbackRestore: "restore-original",
        maxRestoreBytes: 1024,
        fileSystem: {
          ...fsSync,
          renameSync: () => {
            const error = new Error("rename denied") as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          },
        },
      }),
    ).toThrow("Refusing copy fallback through symlink destination");

    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside");
    expect((await fs.lstat(filePath)).isSymbolicLink()).toBe(true);
    expect((await fs.readdir(root)).filter((entry) => entry.startsWith(".fs-safe-replace")))
      .toEqual([]);
  });

  it("supports the synchronous replace variant", async () => {
    const root = await tempRoot("fs-safe-atomic-");
    const filePath = path.join(root, "sync", "state.txt");

    const result = replaceFileAtomicSync({
      filePath,
      content: "sync",
      syncTempFile: true,
      syncParentDir: true,
    });

    expect(result).toEqual({ method: "rename" });
    expect(fsSync.readFileSync(filePath, "utf8")).toBe("sync");
  });

  it("replaces directories through a staged directory", async () => {
    const root = await tempRoot("fs-safe-atomic-");
    const targetDir = path.join(root, "target");
    const stagedDir = path.join(root, "staged");
    await fs.mkdir(targetDir);
    await fs.writeFile(path.join(targetDir, "old.txt"), "old", "utf8");
    await fs.mkdir(stagedDir);
    await fs.writeFile(path.join(stagedDir, "new.txt"), "new", "utf8");

    await replaceDirectoryAtomic({ stagedDir, targetDir });

    await expect(fs.readFile(path.join(targetDir, "new.txt"), "utf8")).resolves.toBe("new");
    await expect(fs.stat(path.join(targetDir, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(stagedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
