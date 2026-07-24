import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureDurableDirectory,
  pinDirectory,
  syncDirectory,
  syncDirectoryBestEffort,
  syncDirectoryBestEffortSync,
  syncDirectorySync,
} from "../src/directory-durability.js";
import { FsSafeError } from "../src/errors.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return await fs.realpath(directory);
}

function isDirectoryOpen(flags: string | number | undefined): boolean {
  return (
    flags === "r" ||
    (typeof flags === "number" && (flags & fsSync.constants.O_DIRECTORY) !== 0)
  );
}

async function createFifo(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("mkfifo", [filePath]);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`mkfifo exited ${code}`));
      }
    });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map(async (directory) => fs.rm(directory, { force: true, recursive: true })),
  );
});

describe("directory durability", () => {
  it("pins, syncs, and revalidates a directory identity", async () => {
    const directory = await tempRoot("fs-safe-directory-pin-");
    const pinned = await pinDirectory(directory, { label: "test directory" });

    expect(pinned.receipt).toMatchObject({ path: directory, realPath: directory });
    await expect(pinned.assertCurrent()).resolves.toBeUndefined();
    if (process.platform === "win32") {
      await expect(pinned.sync()).resolves.toMatchObject({
        status: expect.stringMatching(/^(?:synced|unsupported)$/u),
      });
    } else {
      await expect(pinned.sync()).resolves.toEqual({ status: "synced" });
    }
    await pinned.close();
    await expect(pinned.close()).resolves.toBeUndefined();
    await expect(pinned.assertCurrent()).rejects.toMatchObject({ code: "helper-failed" });
  });

  it("rejects non-directory and symlink inputs", async () => {
    const root = await tempRoot("fs-safe-directory-kind-");
    const filePath = path.join(root, "file");
    await fs.writeFile(filePath, "file");
    await expect(pinDirectory(filePath)).rejects.toMatchObject({ code: "not-file" });

    if (process.platform !== "win32") {
      const linkPath = path.join(root, "link");
      await fs.symlink(root, linkPath);
      await expect(pinDirectory(linkPath)).rejects.toMatchObject({ code: "not-file" });
    }
  });

  it.runIf(process.platform !== "win32")(
    "syncs every newly created parent edge through the nearest existing ancestor",
    async () => {
      const root = await tempRoot("fs-safe-durable-parent-");
      const directoryPath = path.join(root, "one", "two", "three");
      const syncedPaths: string[] = [];
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (isDirectoryOpen(flags)) {
          const resolvedPath = path.resolve(String(filePath));
          const originalSync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            syncedPaths.push(resolvedPath);
            await originalSync();
          });
        }
        return handle;
      });

      const receipt = await ensureDurableDirectory({ directoryPath, mode: 0o700 });

      expect(receipt).toMatchObject({
        path: directoryPath,
        parentSync: { status: "synced" },
      });
      expect(syncedPaths).toEqual([
        path.join(root, "one", "two"),
        path.join(root, "one"),
        root,
      ]);
      expect((await fs.stat(directoryPath)).mode & 0o777).toBe(0o700);
    },
  );

  it("returns not-needed for an existing directory", async () => {
    const directoryPath = await tempRoot("fs-safe-durable-existing-");
    const identity = await fs.lstat(directoryPath);

    await expect(
      ensureDurableDirectory({ directoryPath, expectedExistingIdentity: identity }),
    ).resolves.toMatchObject({
      path: directoryPath,
      parentSync: { status: "not-needed" },
    });
  });

  it("uses a caller-provided creator", async () => {
    const root = await tempRoot("fs-safe-durable-creator-");
    const directoryPath = path.join(root, "one", "two");
    const create = vi.fn(async (targetPath: string) => {
      await fs.mkdir(targetPath, { recursive: true });
    });

    await expect(ensureDurableDirectory({ directoryPath, create })).resolves.toMatchObject({
      path: directoryPath,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(directoryPath);
  });

  it.runIf(process.platform !== "win32")(
    "does not follow a symlink planted in a missing directory chain",
    async () => {
      const root = await tempRoot("fs-safe-durable-symlink-chain-");
      const outside = await tempRoot("fs-safe-durable-symlink-outside-");
      const firstSegment = path.join(root, "one");
      const displacedSegment = path.join(root, "displaced-one");
      const directoryPath = path.join(firstSegment, "two");
      const originalMkdir = fs.mkdir.bind(fs);
      let swapped = false;
      vi.spyOn(fs, "mkdir").mockImplementation(async (targetPath, options) => {
        const result = await originalMkdir(targetPath, options);
        if (!swapped && path.resolve(String(targetPath)) === firstSegment) {
          swapped = true;
          await fs.rename(firstSegment, displacedSegment);
          await fs.symlink(outside, firstSegment);
        }
        return result;
      });

      await expect(ensureDurableDirectory({ directoryPath })).rejects.toMatchObject({
        code: "symlink",
      });
      expect(swapped).toBe(true);
      await expect(fs.readdir(outside)).resolves.toEqual([]);
    },
  );

  it("rejects a creator that does not produce the requested path", async () => {
    const root = await tempRoot("fs-safe-durable-missing-create-");
    const directoryPath = path.join(root, "missing");

    await expect(
      ensureDurableDirectory({ directoryPath, create: async () => undefined }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an expected identity when the requested directory is missing", async () => {
    const root = await tempRoot("fs-safe-durable-missing-expected-");
    const directoryPath = path.join(root, "missing");
    const identity = await fs.lstat(root);

    await expect(
      ensureDurableDirectory({ directoryPath, expectedExistingIdentity: identity }),
    ).rejects.toMatchObject({ code: "path-mismatch" });
  });

  it("fails when a newly created parent edge cannot be synced", async () => {
    const root = await tempRoot("fs-safe-durable-failure-");
    const directoryPath = path.join(root, "one", "two");
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (isDirectoryOpen(flags) && path.resolve(String(filePath)) === root) {
        vi.spyOn(handle, "sync").mockRejectedValue(
          Object.assign(new Error("parent sync failed"), { code: "EIO" }),
        );
      }
      return handle;
    });

    await expect(ensureDurableDirectory({ directoryPath })).rejects.toMatchObject({
      code: "helper-failed",
      cause: { code: "EIO" },
    });
    expect((await fs.stat(directoryPath)).isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "detects a created directory replaced while its parent edge is synced",
    async () => {
      const root = await tempRoot("fs-safe-durable-race-");
      const directoryPath = path.join(root, "one", "two");
      const displacedPath = path.join(root, "displaced-two");
      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (
          isDirectoryOpen(flags) &&
          path.resolve(String(filePath)) === path.join(root, "one")
        ) {
          const originalSync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            replaced = true;
            await fs.rename(directoryPath, displacedPath);
            await fs.mkdir(directoryPath);
            await originalSync();
          });
        }
        return handle;
      });

      await expect(ensureDurableDirectory({ directoryPath })).rejects.toMatchObject({
        code: "path-mismatch",
      });
      expect(replaced).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects an expected existing target replaced before it can be pinned",
    async () => {
      const directoryPath = await tempRoot("fs-safe-durable-existing-race-");
      const displacedPath = `${directoryPath}.displaced`;
      tempDirs.push(displacedPath);
      const expectedIdentity = await fs.lstat(directoryPath);
      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        if (
          !replaced &&
          isDirectoryOpen(flags) &&
          path.resolve(String(filePath)) === directoryPath
        ) {
          replaced = true;
          await fs.rename(directoryPath, displacedPath);
          await fs.mkdir(directoryPath);
        }
        return await originalOpen(filePath, flags, mode);
      });

      await expect(
        ensureDurableDirectory({ directoryPath, expectedExistingIdentity: expectedIdentity }),
      ).rejects.toMatchObject({ code: "path-mismatch" });
      expect(replaced).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a FIFO swapped into a directory path without blocking",
    async () => {
      const directoryPath = await tempRoot("fs-safe-durable-fifo-");
      const displacedPath = `${directoryPath}.displaced`;
      tempDirs.push(displacedPath);
      const originalOpen = fs.open.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        if (
          !replaced &&
          isDirectoryOpen(flags) &&
          path.resolve(String(filePath)) === directoryPath
        ) {
          expect(typeof flags).toBe("number");
          const numericFlags = flags as number;
          expect(numericFlags & fsSync.constants.O_DIRECTORY).toBe(fsSync.constants.O_DIRECTORY);
          expect(numericFlags & fsSync.constants.O_NOFOLLOW).toBe(fsSync.constants.O_NOFOLLOW);
          expect(numericFlags & fsSync.constants.O_NONBLOCK).toBe(fsSync.constants.O_NONBLOCK);
          replaced = true;
          await fs.rename(directoryPath, displacedPath);
          await createFifo(directoryPath);
        }
        return await originalOpen(filePath, flags, mode);
      });

      await expect(pinDirectory(directoryPath)).rejects.toBeDefined();
      expect(replaced).toBe(true);
      await fs.unlink(directoryPath).catch(() => undefined);
    },
  );

  it.runIf(process.platform !== "win32")(
    "syncs the pinned parent when its path is transiently replaced",
    async () => {
      const root = await tempRoot("fs-safe-durable-parent-race-");
      const directoryPath = path.join(root, "one", "two");
      const parentPath = path.dirname(directoryPath);
      const displacedParentPath = path.join(root, "owned-parent");
      const replacementParentPath = path.join(root, "replacement-parent");
      const originalOpen = fs.open.bind(fs);
      let swapped = false;
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (isDirectoryOpen(flags) && path.resolve(String(filePath)) === parentPath) {
          const originalSync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            swapped = true;
            await fs.rename(parentPath, displacedParentPath);
            await fs.mkdir(parentPath);
            await originalSync();
            await fs.rename(parentPath, replacementParentPath);
            await fs.rename(displacedParentPath, parentPath);
          });
        }
        return handle;
      });

      await expect(ensureDurableDirectory({ directoryPath })).resolves.toMatchObject({
        parentSync: { status: "synced" },
      });
      expect(swapped).toBe(true);
    },
  );

  it.each(["EINVAL", "ENOSYS", "ENOTSUP"] as const)(
    "propagates %s directory sync failures outside Windows",
    async (code) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const directoryPath = await tempRoot("fs-safe-posix-sync-");
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error(code), { code }));
        return handle;
      });

      await expect(syncDirectory(directoryPath)).rejects.toMatchObject({ code });
    },
  );

  it.each(["EACCES", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"] as const)(
    "reports %s directory sync failures as unsupported on Windows",
    async (code) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const directoryPath = await tempRoot("fs-safe-windows-sync-");
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error(code), { code }));
        return handle;
      });

      await expect(syncDirectory(directoryPath)).resolves.toEqual({
        status: "unsupported",
        code,
      });
    },
  );

  it("reports an unsupported Windows directory open after revalidating the path", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const directoryPath = await tempRoot("fs-safe-windows-open-");
    vi.spyOn(fs, "open").mockRejectedValue(Object.assign(new Error("unsupported"), { code: "EISDIR" }));

    await expect(syncDirectory(directoryPath)).resolves.toEqual({
      status: "unsupported",
      code: "EISDIR",
    });
  });

  it.each(["EACCES", "EPERM", "EIO"] as const)(
    "propagates Windows %s directory open failures",
    async (code) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const directoryPath = await tempRoot("fs-safe-windows-open-failure-");
      vi.spyOn(fs, "open").mockRejectedValue(Object.assign(new Error(code), { code }));

      await expect(syncDirectory(directoryPath)).rejects.toMatchObject({ code });
    },
  );

  it("keeps synchronous Windows open access failures strict", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const directoryPath = await tempRoot("fs-safe-windows-sync-open-access-");
    vi.spyOn(fsSync, "openSync").mockImplementation(() => {
      throw Object.assign(new Error("access denied"), { code: "EACCES" });
    });

    expect(() => syncDirectorySync(directoryPath)).toThrow(
      expect.objectContaining({ code: "EACCES" }),
    );
  });

  it("reports synchronous Windows directory-open incompatibility", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const directoryPath = await tempRoot("fs-safe-windows-sync-open-unsupported-");
    vi.spyOn(fsSync, "openSync").mockImplementation(() => {
      throw Object.assign(new Error("is directory"), { code: "EISDIR" });
    });

    expect(syncDirectorySync(directoryPath)).toEqual({ status: "unsupported", code: "EISDIR" });
  });

  it.runIf(process.platform !== "win32")(
    "detects a directory replaced during one-shot synchronization",
    async () => {
      const directoryPath = await tempRoot("fs-safe-one-shot-race-");
      const displacedPath = `${directoryPath}.displaced`;
      tempDirs.push(displacedPath);
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        const originalSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          await fs.rename(directoryPath, displacedPath);
          await fs.mkdir(directoryPath);
          await originalSync();
        });
        return handle;
      });

      await expect(syncDirectory(directoryPath)).rejects.toMatchObject({ code: "path-mismatch" });
    },
  );

  it("supports synchronous directory sync and best-effort variants", async () => {
    const directoryPath = await tempRoot("fs-safe-sync-variants-");
    if (process.platform === "win32") {
      expect(syncDirectorySync(directoryPath).status).toMatch(/^(?:synced|unsupported)$/u);
    } else {
      expect(syncDirectorySync(directoryPath)).toEqual({ status: "synced" });
    }
    await expect(syncDirectoryBestEffort(directoryPath)).resolves.toBeUndefined();
    expect(() => syncDirectoryBestEffortSync(directoryPath)).not.toThrow();
  });

  it("keeps best-effort sync non-throwing for real I/O failures", async () => {
    const directoryPath = await tempRoot("fs-safe-sync-best-effort-");
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error("I/O"), { code: "EIO" }));
      return handle;
    });

    await expect(syncDirectoryBestEffort(directoryPath)).resolves.toBeUndefined();
    await expect(syncDirectoryBestEffort(path.join(directoryPath, "missing"))).resolves.toBeUndefined();
    expect(() => syncDirectoryBestEffortSync(path.join(directoryPath, "missing"))).not.toThrow();
  });

  it("uses FsSafeError for directory policy and identity failures", async () => {
    const root = await tempRoot("fs-safe-directory-error-");
    const filePath = path.join(root, "file");
    await fs.writeFile(filePath, "file");

    await expect(pinDirectory(filePath)).rejects.toBeInstanceOf(FsSafeError);
  });
});
