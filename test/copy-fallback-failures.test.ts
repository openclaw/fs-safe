import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AtomicIo, runAsync, runSync, type Procedure } from "../src/atomic-io.js";
import { bindHandle } from "./helpers/file-handle-proxy.js";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  assertDestinationHardlinkPolicy,
  copyFallbackReplace,
} from "../src/replace-file-copy-fallback.js";

const { tempRoot } = useTempDirs();

const MODES = [
  { label: "async", io: AtomicIo.async(fs), run: runAsync },
  { label: "sync", io: AtomicIo.sync(fsSync), run: runSync },
] as const;

async function fixture(prefix: string, sourceBytes: string | null = "replacement", destBytes?: string) {
  const root = await tempRoot(prefix);
  const source = path.join(root, "source"), dest = path.join(root, "dest");
  if (sourceBytes !== null) await fs.writeFile(source, sourceBytes);
  if (destBytes !== undefined) await fs.writeFile(dest, destBytes);
  return { root, source, dest };
}

function copy(io: AtomicIo, options: Pick<Parameters<typeof copyFallbackReplace>[1], "src" | "dest"> &
  Partial<Parameters<typeof copyFallbackReplace>[1]>) {
  return copyFallbackReplace(io, { restore: "none", sync: false, ...options });
}

async function expectGuard(
  mode: (typeof MODES)[number],
  procedure: Procedure<void>,
  expected: string | { code: Parameters<typeof expectFsSafeError>[1] },
) {
  if (mode.label === "async") {
    if (typeof expected === "string") await expect(runAsync(procedure)).rejects.toThrow(expected);
    else await expectFsSafeError(runAsync(procedure), expected.code);
  } else {
    expect(() => runSync(procedure)).toThrow(typeof expected === "string" ? expected : expect.objectContaining(expected));
  }
}

describe("copy fallback source and destination guards", () => {
  it("rejects async and sync non-file sources before opening them", async () => {
    const { source, dest } = await fixture("fs-safe-copy-source-", null);
    await fs.mkdir(source);
    for (const mode of MODES) {
      await expectGuard(mode, copy(mode.io, { src: source, dest }), "non-file source");
    }
  });

  itPosix("rejects symlink sources and destinations without changing their targets", async () => {
    const { root, source, dest } = await fixture("fs-safe-copy-symlink-", "source", "dest");
    const sourceLink = path.join(root, "source-link"), destLink = path.join(root, "dest-link");
    await fs.symlink(source, sourceLink);
    await fs.symlink(dest, destLink);
    for (const mode of MODES) {
      await expectGuard(mode, copy(mode.io, {
        src: sourceLink, dest: path.join(root, `unused-${mode.label}`),
      }), "non-file source");
      const replacement = path.join(root, `${mode.label}-source`);
      await fs.writeFile(replacement, "replacement");
      await expectGuard(mode, copy(mode.io, { src: replacement, dest: destLink }), { code: "symlink" });
    }
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("dest");
  });

  it("rejects source identity changes after open in both implementations", async () => {
    const { root, source, dest } = await fixture("fs-safe-copy-source-race-", "source");
    const other = path.join(root, "other");
    await fs.writeFile(other, "other");
    for (const mode of MODES) {
      let sourceLstats = 0;
      const asyncFs = { ...fs, lstat: (async (candidate, options) =>
        await fs.lstat(String(candidate) === source && ++sourceLstats === 2 ? other : candidate, options)
      ) as typeof fs.lstat };
      const syncModule = { ...fsSync, lstatSync: ((candidate, options) =>
        fsSync.lstatSync(String(candidate) === source && ++sourceLstats === 2 ? other : candidate, options)
      ) as typeof fsSync.lstatSync };
      const io = mode.label === "async" ? AtomicIo.async(asyncFs) : AtomicIo.sync(syncModule);
      await expectGuard(mode, copy(io, { src: source, dest: `${dest}-${mode.label}` }), { code: "path-mismatch" });
    }
  });

  it("rejects a destination whose identity changes while it is pinned", async () => {
    const { root, source, dest } = await fixture("fs-safe-copy-dest-race-", "replacement", "original");
    const other = path.join(root, "other");
    await fs.writeFile(other, "other");
    for (const mode of MODES) {
      const asyncFs = { ...fs, open: (async (candidate, flags, mode) =>
        await fs.open(String(candidate) === dest ? other : candidate, flags, mode)
      ) as typeof fs.open };
      const syncModule = { ...fsSync, openSync: ((candidate, flags, mode) =>
        fsSync.openSync(String(candidate) === dest ? other : candidate, flags, mode)
      ) as typeof fsSync.openSync };
      const io = mode.label === "async" ? AtomicIo.async(asyncFs) : AtomicIo.sync(syncModule);
      await expectGuard(mode, copy(io, {
        src: source, dest, restore: "restore-original", maxRestoreBytes: 32,
      }), { code: "path-mismatch" });
      await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
    }
  });

  itPosix("enforces destination hardlink policy before remove or pinned replacement", async () => {
    const root = await tempRoot("fs-safe-copy-hardlink-");
    const original = path.join(root, "original"), alias = path.join(root, "alias");
    await fs.writeFile(original, "original");
    await fs.link(original, alias);
    for (const mode of MODES) {
      const source = path.join(root, `${mode.label}-source`);
      await fs.writeFile(source, "replacement");
      await expectGuard(mode, assertDestinationHardlinkPolicy(mode.io, alias, "reject"), { code: "hardlink" });
      await expectGuard(mode, copy(mode.io, {
        src: source, dest: alias, destinationHardlinks: "reject", restore: "restore-original", maxRestoreBytes: 32,
      }), { code: "hardlink" });
    }
    await expect(fs.readFile(original, "utf8")).resolves.toBe("original");
  });

  it("treats missing and non-file destinations as no hardlink-policy decision", async () => {
    const root = await tempRoot("fs-safe-copy-policy-noop-");
    const missing = path.join(root, "missing");
    const directory = path.join(root, "directory");
    await fs.mkdir(directory);

    await expect(runAsync(assertDestinationHardlinkPolicy(AtomicIo.async(fs), missing, "reject"))).resolves.toBeUndefined();
    await expect(runAsync(assertDestinationHardlinkPolicy(AtomicIo.async(fs), directory, "reject"))).resolves.toBeUndefined();
    await expect(runAsync(assertDestinationHardlinkPolicy(AtomicIo.async(fs), directory))).resolves.toBeUndefined();
    expect(runSync(assertDestinationHardlinkPolicy(AtomicIo.sync(fsSync), missing, "reject"))).toBeUndefined();
    expect(runSync(assertDestinationHardlinkPolicy(AtomicIo.sync(fsSync), directory, "reject"))).toBeUndefined();
    expect(runSync(assertDestinationHardlinkPolicy(AtomicIo.sync(fsSync), directory))).toBeUndefined();
  });

  itPosix("rejects a destination that becomes a symlink or non-file after open", async () => {
    const { root, source, dest } = await fixture("fs-safe-copy-dest-recheck-", "replacement", "original");
    const linkTarget = path.join(root, "link-target");
    const link = path.join(root, "link");
    const directory = path.join(root, "directory");
    await fs.writeFile(linkTarget, "outside");
    await fs.symlink(linkTarget, link);
    await fs.mkdir(directory);
    let destLstats = 0;
    const symlinkAfterOpen = {
      ...fs,
      async lstat(candidate: fs.PathLike, options?: fsSync.StatOptions) {
        if (String(candidate) === dest && ++destLstats === 2) return await fs.lstat(link, options);
        return await fs.lstat(candidate, options);
      },
    };
    await expectFsSafeError(runAsync(copyFallbackReplace(AtomicIo.async(symlinkAfterOpen), {
      src: source,
      dest,
      restore: "restore-original",
      maxRestoreBytes: 32,
      sync: false,
    })), "symlink");

    const nonFileAfterOpen = {
      ...fs,
      async open(candidate: fs.PathLike, flags: string | number, mode?: number) {
        const handle = await fs.open(candidate, flags, mode);
        if (String(candidate) !== dest) return handle;
        return bindHandle(handle, {
          stat: (async (options) => await fs.stat(directory, options)) as FileHandle["stat"],
          async close() {
            await handle.close();
            throw new Error("close receipt lost");
          },
        });
      },
    };
    await expectFsSafeError(runAsync(copyFallbackReplace(AtomicIo.async(nonFileAfterOpen), {
      src: source,
      dest,
      restore: "restore-original",
      maxRestoreBytes: 32,
      sync: false,
    })), "not-file");
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
    await expectFsSafeError(runAsync(assertDestinationHardlinkPolicy(AtomicIo.async(asyncFs), dest, "reject")), "path-mismatch");

    const syncModule = {
      ...fsSync,
      openSync() {
        return fsSync.openSync(other, "r");
      },
    };
    expect(() => runSync(assertDestinationHardlinkPolicy(AtomicIo.sync(syncModule), dest, "reject")))
      .toThrow(expect.objectContaining({ code: "path-mismatch" }));
  });
});

describe("copy fallback failure and restoration", () => {
  it("restores original bytes when an async write makes no progress", async () => {
    const { source, dest } = await fixture("fs-safe-copy-zero-write-", "replacement", "original");
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

    await expect(runAsync(copyFallbackReplace(AtomicIo.async(asyncFs), {
      src: source,
      dest,
      restore: "restore-original",
      maxRestoreBytes: 8,
      sync: true,
    }))).rejects.toMatchObject({
      code: "helper-failed",
      details: { cleanup: "restored" },
    });
    await expect(fs.readFile(dest, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(source, "utf8")).resolves.toBe("replacement");
    // Real restoration flushes can exceed the default budget under Windows coverage.
  }, process.platform === "win32" ? 30_000 : undefined);

  it("reports a synchronous double fault when neither write makes progress", async () => {
    const { source, dest } = await fixture("fs-safe-copy-zero-write-sync-", "replacement", "original");
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

    expect(() => runSync(copyFallbackReplace(AtomicIo.sync(syncModule), {
      src: source,
      dest,
      restore: "restore-original",
      maxRestoreBytes: 8,
      sync: true,
    }))).toThrow(expect.objectContaining({
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
    runSync(copyFallbackReplace(AtomicIo.sync(fsSync), {
      src: exactSource,
      dest: exactDest,
      restore: "restore-original",
      maxRestoreBytes: 5,
      sync: true,
    }));
    expect(fsSync.readFileSync(exactDest, "utf8")).toBe("new");

    const pastSource = path.join(root, "past-source");
    const pastDest = path.join(root, "past-dest");
    await fs.writeFile(pastSource, "new");
    await fs.writeFile(pastDest, "12345");
    expect(() => runSync(copyFallbackReplace(AtomicIo.sync(fsSync), {
      src: pastSource,
      dest: pastDest,
      restore: "restore-original",
      maxRestoreBytes: 4,
      sync: false,
    }))).toThrow(expect.objectContaining({ code: "too-large" }));
    expect(fsSync.readFileSync(pastDest, "utf8")).toBe("12345");
  });

  it("successfully replaces both missing and existing destinations through each fallback mode", async () => {
    const rows = [
      { mode: MODES[0], bytes: "created", previous: undefined, restore: "restore-original", maxRestoreBytes: 16, sync: false },
      { mode: MODES[0], bytes: "new", previous: "old", restore: "restore-original", maxRestoreBytes: 3, sync: true },
      { mode: MODES[1], bytes: "sync-new", previous: "sync-old", restore: "none", sync: true },
    ] as const;
    for (const { mode, bytes, previous, ...options } of rows) {
      const { source, dest } = await fixture("fs-safe-copy-success-paths-", bytes, previous);
      await mode.run(copyFallbackReplace(mode.io, { src: source, dest, ...options }));
      await expect(fs.readFile(dest, "utf8")).resolves.toBe(bytes);
    }
  });

});
