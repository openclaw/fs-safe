import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSyncDirectoryGuard,
  ensureParentSync,
} from "../src/file-store-boundary.js";
import { fileStoreSync } from "../src/file-store.js";
import * as canonicalPath from "../src/realpath.js";
import { itPosix, itWin32, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

function isDirectoryOpen(flags: string | number): boolean {
  return typeof flags === "number" && typeof fsSync.constants.O_DIRECTORY === "number" &&
    (flags & fsSync.constants.O_DIRECTORY) !== 0;
}

describe("sync file-store directory mode authority", () => {
  itPosix.each([false, true])(
    "does not open or chmod directories whose full mode already matches (private=%s)",
    async (privateMode) => {
      const root = await tempRoot("fs-safe-sync-store-mode-match-");
      const nested = path.join(root, "nested");
      await fs.mkdir(nested);
      await Promise.all([fs.chmod(root, 0o700), fs.chmod(nested, 0o700)]);
      const realOpenSync = fsSync.openSync.bind(fsSync);
      const realFchmodSync = fsSync.fchmodSync.bind(fsSync);
      const pathnameChmod = vi.spyOn(fsSync, "chmodSync");
      let directoryOpens = 0;
      let directoryChmods = 0;
      vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
        if (isDirectoryOpen(args[1])) directoryOpens += 1;
        return realOpenSync(...args);
      }) as typeof fsSync.openSync);
      vi.spyOn(fsSync, "fchmodSync").mockImplementation((descriptor, mode) => {
        if (fsSync.fstatSync(descriptor).isDirectory()) directoryChmods += 1;
        realFchmodSync(descriptor, mode);
      });

      fileStoreSync({ rootDir: root, private: privateMode, durable: false, dirMode: 0o700 })
        .write("nested/value", "value");

      expect({ directoryOpens, directoryChmods }).toEqual({
        directoryOpens: 0,
        directoryChmods: 0,
      });
      expect(pathnameChmod).not.toHaveBeenCalled();
    },
  );

  itPosix.each([false, true])(
    "repairs mismatched root and component modes through no-follow descriptors (private=%s)",
    async (privateMode) => {
      const root = await tempRoot("fs-safe-sync-store-mode-repair-");
      const nested = path.join(root, "nested");
      await fs.mkdir(nested);
      await Promise.all([fs.chmod(root, 0o755), fs.chmod(nested, 0o755)]);
      const realOpenSync = fsSync.openSync.bind(fsSync);
      const directoryFlags: number[] = [];
      vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
        if (isDirectoryOpen(args[1])) directoryFlags.push(args[1] as number);
        return realOpenSync(...args);
      }) as typeof fsSync.openSync);

      fileStoreSync({ rootDir: root, private: privateMode, durable: false, dirMode: 0o710 })
        .write("nested/value", "value");

      expect(directoryFlags).toHaveLength(2);
      for (const flags of directoryFlags) {
        expect(flags & fsSync.constants.O_DIRECTORY).not.toBe(0);
        expect(flags & fsSync.constants.O_NOFOLLOW).not.toBe(0);
        expect(flags & fsSync.constants.O_NONBLOCK).not.toBe(0);
      }
      expect((await fs.stat(root)).mode & 0o7777).toBe(0o710);
      expect((await fs.stat(nested)).mode & 0o7777).toBe(0o710);
    },
  );

  itPosix("keeps same-mode deep walks to root and final realpaths", async () => {
    const root = await tempRoot("fs-safe-sync-store-mode-linear-");
    const nested = path.join(root, "a", "b", "c", "d");
    await fs.mkdir(nested, { recursive: true });
    await Promise.all([
      fs.chmod(root, 0o700),
      ...["a", "a/b", "a/b/c", "a/b/c/d"]
        .map((relative) => fs.chmod(path.join(root, relative), 0o700)),
    ]);
    const realRealpath = canonicalPath.realpathSync.native;
    const observed: string[] = [];
    vi.spyOn(canonicalPath.realpathSync, "native").mockImplementation((input) => {
      observed.push(String(input));
      return realRealpath(input);
    });

    ensureParentSync({
      rootDir: root,
      filePath: path.join(nested, "value"),
      mode: 0o700,
    });

    expect(new Set(observed)).toEqual(new Set([root, nested]));
    expect(observed.filter((entry) => entry === nested)).toHaveLength(2);
  });

  itPosix.each([false, true])(
    "finalizes new directories despite a restrictive umask (private=%s)",
    async (privateMode) => {
      const container = await tempRoot("fs-safe-sync-store-mode-create-");
      const root = path.join(container, "store");
      const previousUmask = process.umask(0o077);
      try {
        fileStoreSync({ rootDir: root, private: privateMode, durable: false, dirMode: 0o750 })
          .write("one/two/value", "value");
      } finally {
        process.umask(previousUmask);
      }
      for (const directory of [root, path.join(root, "one"), path.join(root, "one", "two")]) {
        expect((await fs.stat(directory)).mode & 0o7777).toBe(0o750);
      }
    },
  );

  itPosix.each([false, true])(
    "revalidates a directory pathname after opening and before fchmod (private=%s)",
    async (privateMode) => {
      const container = await tempRoot("fs-safe-sync-store-mode-open-swap-");
      const root = path.join(container, "store");
      const displaced = path.join(container, "store-displaced");
      const outside = path.join(container, "outside");
      await Promise.all([fs.mkdir(root), fs.mkdir(outside)]);
      await Promise.all([fs.chmod(root, 0o755), fs.chmod(outside, 0o755)]);
      const realOpenSync = fsSync.openSync.bind(fsSync);
      const realFchmodSync = fsSync.fchmodSync.bind(fsSync);
      let swapped = false;
      let directoryChmods = 0;
      vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
        const descriptor = realOpenSync(...args);
        if (!swapped && path.resolve(String(args[0])) === root && isDirectoryOpen(args[1])) {
          fsSync.renameSync(root, displaced);
          fsSync.symlinkSync(outside, root, "dir");
          swapped = true;
        }
        return descriptor;
      }) as typeof fsSync.openSync);
      vi.spyOn(fsSync, "fchmodSync").mockImplementation((descriptor, mode) => {
        if (fsSync.fstatSync(descriptor).isDirectory()) directoryChmods += 1;
        realFchmodSync(descriptor, mode);
      });

      expect(() => fileStoreSync({
        rootDir: root,
        private: privateMode,
        durable: false,
        dirMode: 0o700,
      }).write("value", "value")).toThrow(expect.objectContaining({ code: "outside-workspace" }));

      expect(directoryChmods).toBe(0);
      expect((await fs.stat(outside)).mode & 0o7777).toBe(0o755);
      await expect(fs.access(path.join(outside, "value"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  itPosix.each([false, true])(
    "maps a root replacement during descriptor acquisition to the boundary (private=%s)",
    async (privateMode) => {
      const container = await tempRoot("fs-safe-sync-store-mode-acquire-swap-");
      const root = path.join(container, "store");
      const displaced = path.join(container, "store-displaced");
      const outside = path.join(container, "outside");
      await Promise.all([fs.mkdir(root), fs.mkdir(outside)]);
      await Promise.all([fs.chmod(root, 0o755), fs.chmod(outside, 0o755)]);
      const realOpenSync = fsSync.openSync.bind(fsSync);
      let swapped = false;
      vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
        if (!swapped && path.resolve(String(args[0])) === root && isDirectoryOpen(args[1])) {
          fsSync.renameSync(root, displaced);
          fsSync.symlinkSync(outside, root, "dir");
          swapped = true;
        }
        return realOpenSync(...args);
      }) as typeof fsSync.openSync);

      let failure: unknown;
      try {
        fileStoreSync({
          rootDir: root,
          private: privateMode,
          durable: false,
          dirMode: 0o700,
        }).write("value", "value");
      } catch (error) {
        failure = error;
      }

      expect(failure).toEqual(expect.objectContaining({
        code: "outside-workspace",
        cause: expect.objectContaining({
          name: "SuppressedError",
          suppressed: expect.objectContaining({ code: expect.any(String) }),
        }),
      }));
      expect((await fs.stat(outside)).mode & 0o7777).toBe(0o755);
      await expect(fs.access(path.join(outside, "value"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  itPosix("preserves an ordinary descriptor acquisition error when the boundary is unchanged", async () => {
    const root = await tempRoot("fs-safe-sync-store-mode-open-error-");
    await fs.chmod(root, 0o755);
    const openFailure = Object.assign(new Error("directory open failed"), { code: "EIO" });
    const realOpenSync = fsSync.openSync.bind(fsSync);
    vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
      if (path.resolve(String(args[0])) === root && isDirectoryOpen(args[1])) throw openFailure;
      return realOpenSync(...args);
    }) as typeof fsSync.openSync);

    let failure: unknown;
    try {
      fileStoreSync({ rootDir: root, durable: false, dirMode: 0o700 })
        .write("value", "value");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(openFailure);
  });

  itPosix.each([false, true])(
    "rejects a post-fchmod root replacement without changing the replacement (private=%s)",
    async (privateMode) => {
      const container = await tempRoot("fs-safe-sync-store-mode-post-chmod-swap-");
      const root = path.join(container, "store");
      const displaced = path.join(container, "store-displaced");
      const outside = path.join(container, "outside");
      await Promise.all([fs.mkdir(root), fs.mkdir(outside)]);
      await Promise.all([fs.chmod(root, 0o755), fs.chmod(outside, 0o755)]);
      const realFchmodSync = fsSync.fchmodSync.bind(fsSync);
      let swapped = false;
      vi.spyOn(fsSync, "fchmodSync").mockImplementation((descriptor, mode) => {
        realFchmodSync(descriptor, mode);
        if (!swapped && fsSync.fstatSync(descriptor).isDirectory()) {
          fsSync.renameSync(root, displaced);
          fsSync.symlinkSync(outside, root, "dir");
          swapped = true;
        }
      });

      expect(() => fileStoreSync({
        rootDir: root,
        private: privateMode,
        durable: false,
        dirMode: 0o700,
      }).write("value", "value")).toThrow(expect.objectContaining({ code: "outside-workspace" }));

      expect((await fs.stat(displaced)).mode & 0o7777).toBe(0o700);
      expect((await fs.stat(outside)).mode & 0o7777).toBe(0o755);
      await expect(fs.access(path.join(outside, "value"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  itPosix("rejects a successful but ineffective directory fchmod", async () => {
    const root = await tempRoot("fs-safe-sync-store-mode-ineffective-");
    await fs.chmod(root, 0o755);
    const realFchmodSync = fsSync.fchmodSync.bind(fsSync);
    vi.spyOn(fsSync, "fchmodSync").mockImplementation((descriptor, mode) => {
      if (!fsSync.fstatSync(descriptor).isDirectory()) realFchmodSync(descriptor, mode);
    });

    expect(() => fileStoreSync({ rootDir: root, durable: false, dirMode: 0o700 })
      .write("value", "value"))
      .toThrow(expect.objectContaining({ code: "insecure-permissions" }));
    expect((await fs.stat(root)).mode & 0o7777).toBe(0o755);
  });

  itPosix.each([false, true])(
    "retains requested directory special bits (private=%s)",
    async (privateMode) => {
      const root = await tempRoot("fs-safe-sync-store-mode-special-");
      const nested = path.join(root, "nested");
      await fs.mkdir(nested);
      await Promise.all([fs.chmod(root, 0o700), fs.chmod(nested, 0o700)]);

      fileStoreSync({ rootDir: root, private: privateMode, durable: false, dirMode: 0o1700 })
        .write("nested/value", "value");

      expect((await fs.stat(root)).mode & 0o7777).toBe(0o1700);
      expect((await fs.stat(nested)).mode & 0o7777).toBe(0o1700);
    },
  );

  itPosix("retains exact bigint directory guards across colliding numeric projections", async () => {
    const root = await tempRoot("fs-safe-sync-store-mode-wide-");
    const nested = path.join(root, "nested");
    await fs.mkdir(nested);
    await Promise.all([fs.chmod(root, 0o700), fs.chmod(nested, 0o700)]);
    const projected = new Map([[nested, (1n << 56n) + 1n]]);
    const realLstatSync = fsSync.lstatSync.bind(fsSync);
    const project = <T extends Stats | BigIntStats>(stat: T, pathname: string): T => {
      const ino = projected.get(pathname);
      return ino === undefined ? stat : Object.assign(Object.create(stat), {
        ino: typeof stat.ino === "bigint" ? ino : Number(ino),
      });
    };
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args) =>
      project(realLstatSync(...args), String(args[0]))) as typeof fsSync.lstatSync);

    const guard = ensureParentSync({
      rootDir: root,
      filePath: path.join(nested, "value"),
      mode: 0o700,
    });
    const original = guard.exactStat.ino;
    expect(typeof original).toBe("bigint");
    projected.set(nested, original + 2n);
    expect(Number(original + 2n)).toBe(Number(original));
    expect(() => assertSyncDirectoryGuard(guard)).toThrow(
      expect.objectContaining({ code: "path-mismatch" }),
    );
  });

  itPosix("rejects an exact descriptor identity mismatch before fchmod", async () => {
    const root = await tempRoot("fs-safe-sync-store-mode-fd-identity-");
    await fs.chmod(root, 0o755);
    const realOpenSync = fsSync.openSync.bind(fsSync);
    const realFstatSync = fsSync.fstatSync.bind(fsSync);
    const directoryChmod = vi.spyOn(fsSync, "fchmodSync");
    let directoryDescriptor: number | undefined;
    vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
      const descriptor = realOpenSync(...args);
      if (isDirectoryOpen(args[1])) directoryDescriptor = descriptor;
      return descriptor;
    }) as typeof fsSync.openSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args) => {
      const stat = realFstatSync(...args);
      if (args[0] !== directoryDescriptor || typeof stat.ino !== "bigint") return stat;
      return Object.assign(Object.create(stat), { ino: stat.ino + (1n << 56n) });
    }) as typeof fsSync.fstatSync);

    expect(() => fileStoreSync({ rootDir: root, durable: false, dirMode: 0o700 })
      .write("value", "value"))
      .toThrow(expect.objectContaining({ code: "outside-workspace" }));
    expect(directoryChmod).not.toHaveBeenCalled();
  });

  it.runIf(
    (process.platform === "linux" || process.platform === "darwin") &&
      process.getuid?.() !== 0,
  ).each([
    { mode: 0o300, darwinRepairs: true },
    { mode: 0o100, darwinRepairs: true },
    { mode: 0o000, darwinRepairs: false },
  ])("handles directory mode $mode without pathname chmod", async ({ mode, darwinRepairs }) => {
    const root = await tempRoot("fs-safe-sync-store-mode-search-only-");
    await fs.chmod(root, mode);
    let failure: unknown;
    try {
      fileStoreSync({ rootDir: root, durable: false, dirMode: 0o700 })
        .write("value", "value");
    } catch (error) {
      failure = error;
    }
    if (process.platform === "darwin" && darwinRepairs) {
      expect(failure).toBeUndefined();
      expect((await fs.stat(root)).mode & 0o7777).toBe(0o700);
    } else {
      expect(failure).toEqual(expect.objectContaining({ code: "permission-unverified" }));
      expect((await fs.stat(root)).mode & 0o7777).toBe(mode);
      await fs.chmod(root, 0o700);
    }
  });

  it.runIf(
    (process.platform === "linux" || process.platform === "darwin") &&
      process.getuid?.() !== 0,
  )("handles owner-read-removing umask directory creation without a path fallback", async () => {
    const container = await tempRoot("fs-safe-sync-store-mode-owner-umask-");
    const root = path.join(container, "store");
    let failure: unknown;
    const previousUmask = process.umask(0o400);
    try {
      try {
        fileStoreSync({ rootDir: root, durable: false, dirMode: 0o700 })
          .write("value", "value");
      } catch (error) {
        failure = error;
      }
    } finally {
      process.umask(previousUmask);
    }
    if (process.platform === "darwin") {
      expect(failure).toBeUndefined();
      expect((await fs.stat(root)).mode & 0o7777).toBe(0o700);
    } else {
      expect(failure).toEqual(expect.objectContaining({ code: "permission-unverified" }));
      expect((await fs.stat(root)).mode & 0o7777).toBe(0o300);
      await fs.chmod(root, 0o700);
    }
  });

  itPosix("preserves mode and close failures during descriptor cleanup", async () => {
    const root = await tempRoot("fs-safe-sync-store-mode-close-");
    await fs.chmod(root, 0o755);
    const modeFailure = new Error("directory fchmod failed");
    const closeFailure = new Error("directory close failed");
    const realOpenSync = fsSync.openSync.bind(fsSync);
    const realCloseSync = fsSync.closeSync.bind(fsSync);
    let directoryDescriptor: number | undefined;
    vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
      const descriptor = realOpenSync(...args);
      if (isDirectoryOpen(args[1])) directoryDescriptor = descriptor;
      return descriptor;
    }) as typeof fsSync.openSync);
    vi.spyOn(fsSync, "fchmodSync").mockImplementation((descriptor) => {
      if (descriptor === directoryDescriptor) throw modeFailure;
    });
    vi.spyOn(fsSync, "closeSync").mockImplementation((descriptor) => {
      if (descriptor === directoryDescriptor) throw closeFailure;
      realCloseSync(descriptor);
    });

    let failure: unknown;
    try {
      fileStoreSync({ rootDir: root, durable: false, dirMode: 0o700 })
        .write("value", "value");
    } catch (error) {
      failure = error;
    }

    vi.restoreAllMocks();
    if (directoryDescriptor !== undefined) realCloseSync(directoryDescriptor);
    expect(failure).toEqual(expect.objectContaining({
        name: "SuppressedError",
        error: closeFailure,
        suppressed: modeFailure,
      }));
  });

  itWin32.each([false, true])(
    "uses mkdir mode without pathname chmod or directory descriptors (private=%s)",
    async (privateMode) => {
      const container = await tempRoot("fs-safe-sync-store-mode-win32-");
      const root = path.join(container, "store");
      const chmod = vi.spyOn(fsSync, "chmodSync");
      const realOpenSync = fsSync.openSync.bind(fsSync);
      let directoryOpens = 0;
      vi.spyOn(fsSync, "openSync").mockImplementation(((...args) => {
        if (isDirectoryOpen(args[1])) directoryOpens += 1;
        return realOpenSync(...args);
      }) as typeof fsSync.openSync);

      fileStoreSync({ rootDir: root, private: privateMode, durable: false, dirMode: 0o710 })
        .write("nested/value", "value");

      expect(chmod).not.toHaveBeenCalled();
      expect(directoryOpens).toBe(0);
      await expect(fs.readFile(path.join(root, "nested", "value"), "utf8")).resolves.toBe("value");
    },
  );
});
