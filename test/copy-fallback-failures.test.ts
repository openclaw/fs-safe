import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  assertDestinationHardlinkPolicy,
  assertDestinationHardlinkPolicySync,
  copyFallbackReplace,
  copyFallbackReplaceSync,
} from "../src/replace-file-copy-fallback.js";

const { tempRoot } = useTempDirs();

function bindHandle(handle: FileHandle, overrides: Partial<FileHandle>): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof FileHandle];
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("copy fallback source and destination guards", () => {
  it("rejects async and sync non-file sources before opening them", async () => {
    const root = await tempRoot("fs-safe-copy-source-");
    const directory = path.join(root, "source");
    const dest = path.join(root, "dest");
    await fs.mkdir(directory);

    await expect(copyFallbackReplace({
      fsModule: fs,
      src: directory,
      dest,
      restore: "none",
      sync: false,
    })).rejects.toThrow("non-file source");
    expect(() => copyFallbackReplaceSync({
      fsModule: fsSync,
      src: directory,
      dest,
      restore: "none",
      sync: false,
    })).toThrow("non-file source");
  });

  itPosix("rejects symlink sources and destinations without changing their targets", async () => {
    const root = await tempRoot("fs-safe-copy-symlink-");
    const sourceTarget = path.join(root, "source-target");
    const sourceLink = path.join(root, "source-link");
    const destTarget = path.join(root, "dest-target");
    const destLink = path.join(root, "dest-link");
    await fs.writeFile(sourceTarget, "source");
    await fs.writeFile(destTarget, "dest");
    await fs.symlink(sourceTarget, sourceLink);
    await fs.symlink(destTarget, destLink);

    await expect(copyFallbackReplace({
      fsModule: fs,
      src: sourceLink,
      dest: path.join(root, "unused"),
      restore: "none",
      sync: false,
    })).rejects.toThrow("non-file source");
    expect(() => copyFallbackReplaceSync({
      fsModule: fsSync,
      src: sourceLink,
      dest: path.join(root, "unused-sync"),
      restore: "none",
      sync: false,
    })).toThrow("non-file source");

    const asyncSource = path.join(root, "async-source");
    const syncSource = path.join(root, "sync-source");
    await fs.writeFile(asyncSource, "replacement");
    await fs.writeFile(syncSource, "replacement");
    await expect(copyFallbackReplace({
      fsModule: fs,
      src: asyncSource,
      dest: destLink,
      restore: "none",
      sync: false,
    })).rejects.toMatchObject({ code: "symlink" });
    expect(() => copyFallbackReplaceSync({
      fsModule: fsSync,
      src: syncSource,
      dest: destLink,
      restore: "none",
      sync: false,
    })).toThrow(expect.objectContaining({ code: "symlink" }));
    await expect(fs.readFile(destTarget, "utf8")).resolves.toBe("dest");
  });

  it("rejects source identity changes after open in both implementations", async () => {
    const root = await tempRoot("fs-safe-copy-source-race-");
    const source = path.join(root, "source");
    const other = path.join(root, "other");
    await fs.writeFile(source, "source");
    await fs.writeFile(other, "other");
    let sourceLstats = 0;
    const asyncFs = {
      ...fs,
      async lstat(candidate: fs.PathLike) {
        if (String(candidate) === source && ++sourceLstats === 2) return await fs.lstat(other);
        return await fs.lstat(candidate);
      },
    };
    await expectFsSafeError(copyFallbackReplace({
      fsModule: asyncFs,
      src: source,
      dest: path.join(root, "dest"),
      restore: "none",
      sync: false,
    }), "path-mismatch");

    sourceLstats = 0;
    const syncModule = {
      ...fsSync,
      lstatSync(candidate: fsSync.PathLike) {
        if (String(candidate) === source && ++sourceLstats === 2) return fsSync.lstatSync(other);
        return fsSync.lstatSync(candidate);
      },
    };
    expect(() => copyFallbackReplaceSync({
      fsModule: syncModule,
      src: source,
      dest: path.join(root, "dest-sync"),
      restore: "none",
      sync: false,
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  });

  it("rejects a destination whose identity changes while it is pinned", async () => {
    const root = await tempRoot("fs-safe-copy-dest-race-");
    const source = path.join(root, "source");
    const dest = path.join(root, "dest");
    const other = path.join(root, "other");
    await fs.writeFile(source, "replacement");
    await fs.writeFile(dest, "original");
    await fs.writeFile(other, "other");
    const asyncFs = {
      ...fs,
      async open(candidate: fs.PathLike, flags: string | number, mode?: number) {
        return await fs.open(String(candidate) === dest ? other : candidate, flags, mode);
      },
    };

    await expectFsSafeError(copyFallbackReplace({
      fsModule: asyncFs,
      src: source,
      dest,
      restore: "restore-original",
      maxRestoreBytes: 32,
      sync: false,
    }), "path-mismatch");
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");

    const syncModule = {
      ...fsSync,
      openSync(candidate: fsSync.PathLike, flags: fsSync.OpenMode, mode?: fsSync.Mode) {
        return fsSync.openSync(String(candidate) === dest ? other : candidate, flags, mode);
      },
    };
    expect(() => copyFallbackReplaceSync({
      fsModule: syncModule,
      src: source,
      dest,
      restore: "restore-original",
      maxRestoreBytes: 32,
      sync: false,
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  });

  itPosix("enforces destination hardlink policy before remove or pinned replacement", async () => {
    const root = await tempRoot("fs-safe-copy-hardlink-");
    const original = path.join(root, "original");
    const alias = path.join(root, "alias");
    const asyncSource = path.join(root, "async-source");
    const syncSource = path.join(root, "sync-source");
    await fs.writeFile(original, "original");
    await fs.link(original, alias);
    await fs.writeFile(asyncSource, "replacement");
    await fs.writeFile(syncSource, "replacement");

    await expectFsSafeError(assertDestinationHardlinkPolicy(fs, alias, "reject"), "hardlink");
    expect(() => assertDestinationHardlinkPolicySync(fsSync, alias, "reject"))
      .toThrow(expect.objectContaining({ code: "hardlink" }));
    await expectFsSafeError(copyFallbackReplace({
      fsModule: fs,
      src: asyncSource,
      dest: alias,
      destinationHardlinks: "reject",
      restore: "restore-original",
      maxRestoreBytes: 32,
      sync: false,
    }), "hardlink");
    expect(() => copyFallbackReplaceSync({
      fsModule: fsSync,
      src: syncSource,
      dest: alias,
      destinationHardlinks: "reject",
      restore: "restore-original",
      maxRestoreBytes: 32,
      sync: false,
    })).toThrow(expect.objectContaining({ code: "hardlink" }));
    await expect(fs.readFile(original, "utf8")).resolves.toBe("original");
  });

  it("treats missing and non-file destinations as no hardlink-policy decision", async () => {
    const root = await tempRoot("fs-safe-copy-policy-noop-");
    const missing = path.join(root, "missing");
    const directory = path.join(root, "directory");
    await fs.mkdir(directory);

    await expect(assertDestinationHardlinkPolicy(fs, missing, "reject")).resolves.toBeUndefined();
    await expect(assertDestinationHardlinkPolicy(fs, directory, "reject")).resolves.toBeUndefined();
    await expect(assertDestinationHardlinkPolicy(fs, directory)).resolves.toBeUndefined();
    expect(assertDestinationHardlinkPolicySync(fsSync, missing, "reject")).toBeUndefined();
    expect(assertDestinationHardlinkPolicySync(fsSync, directory, "reject")).toBeUndefined();
    expect(assertDestinationHardlinkPolicySync(fsSync, directory)).toBeUndefined();
  });

  itPosix("rejects a destination that becomes a symlink or non-file after open", async () => {
    const root = await tempRoot("fs-safe-copy-dest-recheck-");
    const source = path.join(root, "source");
    const dest = path.join(root, "dest");
    const linkTarget = path.join(root, "link-target");
    const link = path.join(root, "link");
    const directory = path.join(root, "directory");
    await fs.writeFile(source, "replacement");
    await fs.writeFile(dest, "original");
    await fs.writeFile(linkTarget, "outside");
    await fs.symlink(linkTarget, link);
    await fs.mkdir(directory);
    let destLstats = 0;
    const symlinkAfterOpen = {
      ...fs,
      async lstat(candidate: fs.PathLike) {
        if (String(candidate) === dest && ++destLstats === 2) return await fs.lstat(link);
        return await fs.lstat(candidate);
      },
    };
    await expectFsSafeError(copyFallbackReplace({
      fsModule: symlinkAfterOpen,
      src: source,
      dest,
      restore: "restore-original",
      maxRestoreBytes: 32,
      sync: false,
    }), "symlink");

    const directoryStat = await fs.stat(directory);
    const nonFileAfterOpen = {
      ...fs,
      async open(candidate: fs.PathLike, flags: string | number, mode?: number) {
        const handle = await fs.open(candidate, flags, mode);
        if (String(candidate) !== dest) return handle;
        return bindHandle(handle, {
          stat: (async () => directoryStat) as FileHandle["stat"],
          async close() {
            await handle.close();
            throw new Error("close receipt lost");
          },
        });
      },
    };
    await expectFsSafeError(copyFallbackReplace({
      fsModule: nonFileAfterOpen,
      src: source,
      dest,
      restore: "restore-original",
      maxRestoreBytes: 32,
      sync: false,
    }), "not-file");
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
  });

  it("closes hardlink-policy handles when identity validation fails", async () => {
    const root = await tempRoot("fs-safe-copy-policy-race-");
    const dest = path.join(root, "dest");
    const other = path.join(root, "other");
    await fs.writeFile(dest, "dest");
    await fs.writeFile(other, "other");
    const asyncFs = {
      ...fs,
      async open() {
        const handle = await fs.open(other, "r");
        return bindHandle(handle, {
          async close() {
            await handle.close();
            throw new Error("close receipt lost");
          },
        });
      },
    };
    await expectFsSafeError(assertDestinationHardlinkPolicy(asyncFs, dest, "reject"), "path-mismatch");

    const syncModule = {
      ...fsSync,
      openSync() {
        return fsSync.openSync(other, "r");
      },
    };
    expect(() => assertDestinationHardlinkPolicySync(syncModule, dest, "reject"))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
  });
});

describe("copy fallback failure and restoration", () => {
  it("restores original bytes when an async write makes no progress", async () => {
    const root = await tempRoot("fs-safe-copy-zero-write-");
    const source = path.join(root, "source");
    const dest = path.join(root, "dest");
    await fs.writeFile(source, "replacement");
    await fs.writeFile(dest, "original");
    let writes = 0;
    const asyncFs = {
      ...fs,
      async open(candidate: fs.PathLike, flags: string | number, mode?: number) {
        const handle = await fs.open(candidate, flags, mode);
        if (String(candidate) !== dest) return handle;
        return bindHandle(handle, {
          write: (async (...args: Parameters<FileHandle["write"]>) => {
            writes += 1;
            if (writes === 1) return { bytesWritten: 0, buffer: args[0] };
            return await handle.write(...args);
          }) as FileHandle["write"],
        });
      },
    };

    await expect(copyFallbackReplace({
      fsModule: asyncFs,
      src: source,
      dest,
      restore: "restore-original",
      maxRestoreBytes: 8,
      sync: true,
    })).rejects.toMatchObject({
      code: "helper-failed",
      details: { cleanup: "restored" },
    });
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(source, "utf8")).resolves.toBe("replacement");
  });

  it("reports a synchronous double fault when neither write makes progress", async () => {
    const root = await tempRoot("fs-safe-copy-zero-write-sync-");
    const source = path.join(root, "source");
    const dest = path.join(root, "dest");
    await fs.writeFile(source, "replacement");
    await fs.writeFile(dest, "original");
    let destFd: number | undefined;
    const syncModule = {
      ...fsSync,
      openSync(candidate: fsSync.PathLike, flags: fsSync.OpenMode, mode?: fsSync.Mode) {
        const fd = fsSync.openSync(candidate, flags, mode);
        if (String(candidate) === dest && typeof flags === "number" && (flags & fsSync.constants.O_RDWR)) {
          destFd = fd;
        }
        return fd;
      },
      writeSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number) {
        if (fd === destFd) return 0;
        return fsSync.writeSync(fd, buffer, offset, length, position);
      },
    };

    expect(() => copyFallbackReplaceSync({
      fsModule: syncModule,
      src: source,
      dest,
      restore: "restore-original",
      maxRestoreBytes: 8,
      sync: true,
    })).toThrow(expect.objectContaining({
      code: "helper-failed",
      details: { cleanup: "restore-failed" },
      cause: expect.any(AggregateError),
    }));
    await expect(fs.readFile(source, "utf8")).resolves.toBe("replacement");
  });

  it("accepts an exact restore budget and rejects one byte less before mutation", async () => {
    const root = await tempRoot("fs-safe-copy-restore-limit-");
    const exactSource = path.join(root, "exact-source");
    const exactDest = path.join(root, "exact-dest");
    await fs.writeFile(exactSource, "new");
    await fs.writeFile(exactDest, "12345");
    copyFallbackReplaceSync({
      fsModule: fsSync,
      src: exactSource,
      dest: exactDest,
      restore: "restore-original",
      maxRestoreBytes: 5,
      sync: true,
    });
    expect(fsSync.readFileSync(exactDest, "utf8")).toBe("new");

    const pastSource = path.join(root, "past-source");
    const pastDest = path.join(root, "past-dest");
    await fs.writeFile(pastSource, "new");
    await fs.writeFile(pastDest, "12345");
    expect(() => copyFallbackReplaceSync({
      fsModule: fsSync,
      src: pastSource,
      dest: pastDest,
      restore: "restore-original",
      maxRestoreBytes: 4,
      sync: false,
    })).toThrow(expect.objectContaining({ code: "too-large" }));
    expect(fsSync.readFileSync(pastDest, "utf8")).toBe("12345");
  });

  it("successfully replaces both missing and existing destinations through each fallback mode", async () => {
    const root = await tempRoot("fs-safe-copy-success-paths-");
    const missingSource = path.join(root, "missing-source");
    const missingDest = path.join(root, "missing-dest");
    await fs.writeFile(missingSource, "created");
    await copyFallbackReplace({
      fsModule: fs,
      src: missingSource,
      dest: missingDest,
      restore: "restore-original",
      maxRestoreBytes: 16,
      sync: false,
    });
    await expect(fs.readFile(missingDest, "utf8")).resolves.toBe("created");

    const pinnedSource = path.join(root, "pinned-source");
    const pinnedDest = path.join(root, "pinned-dest");
    await fs.writeFile(pinnedSource, "new");
    await fs.writeFile(pinnedDest, "old");
    await copyFallbackReplace({
      fsModule: fs,
      src: pinnedSource,
      dest: pinnedDest,
      restore: "restore-original",
      maxRestoreBytes: 3,
      sync: true,
    });
    await expect(fs.readFile(pinnedDest, "utf8")).resolves.toBe("new");

    const syncSource = path.join(root, "sync-source");
    const syncDest = path.join(root, "sync-dest");
    await fs.writeFile(syncSource, "sync-new");
    await fs.writeFile(syncDest, "sync-old");
    copyFallbackReplaceSync({
      fsModule: fsSync,
      src: syncSource,
      dest: syncDest,
      restore: "none",
      sync: true,
    });
    expect(fsSync.readFileSync(syncDest, "utf8")).toBe("sync-new");
  });

});
