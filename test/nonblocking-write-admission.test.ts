import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import {
  appendRegularFile,
  appendRegularFileSync,
  resolveRegularFileAppendFlags,
} from "../src/regular-file.js";
import { root as openRoot } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import {
  isNonRegularWriteOpenError,
  isNonRegularWriteOpenErrorSync,
  resolveNonblockingWriteFlag,
} from "../src/write-open-flags.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const constants = fsSync.constants;
afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

function makeFifo(filePath: string): fsSync.Stats {
  expect(spawnSync("mkfifo", [filePath]).status).toBe(0);
  return fsSync.lstatSync(filePath);
}

function expectNonblocking(flags: string | number): void {
  expect(typeof flags).toBe("number");
  expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
}

function expectWriteOnly(flags: string | number): void {
  expect(Number(flags) & (constants.O_WRONLY | constants.O_RDWR)).toBe(constants.O_WRONLY);
}

describe("nonblocking writable admission", () => {
  itPosix.each(["replace", "update", "append"] as const)(
    "rejects a stable no-reader FIFO in Root %s without changing it",
    async (writeMode) => {
      const dir = await tempRoot("fs-safe-root-write-fifo-");
      const filePath = path.join(dir, "fifo");
      const before = makeFifo(filePath);
      const scoped = await openRoot(dir);
      const realOpen = fs.open.bind(fs);
      const mutations: ReturnType<typeof vi.spyOn>[] = [];
      const open = vi.spyOn(fs, "open").mockImplementationOnce(async (candidate, flags, mode) => {
        expect(candidate).toBe(filePath);
        // Fail before the real syscall if the admission safeguard is missing.
        expectNonblocking(flags);
        expect(Number(flags) & (constants.O_TRUNC | constants.O_CREAT | constants.O_EXCL)).toBe(0);
        if (writeMode !== "append") expectWriteOnly(flags);
        const handle = await realOpen(candidate, flags, mode);
        mutations.push(vi.spyOn(handle, "chmod"), vi.spyOn(handle, "truncate"),
          vi.spyOn(handle, "write"), vi.spyOn(handle, "appendFile"));
        return handle;
      });

      const pending = scoped.openWritable("fifo", { writeMode, mkdir: false });
      await expect(pending).rejects.toBeInstanceOf(FsSafeError);
      await expect(pending).rejects.toMatchObject({
        code: "not-file", message: "path is not a regular file under root",
      });
      expect(open).toHaveBeenCalledTimes(1);
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
      expect(fsSync.lstatSync(filePath)).toEqual(before);
      expect(fsSync.readdirSync(dir)).toEqual(["fifo"]);
    },
  );

  itPosix.each(["async", "sync"] as const)(
    "rejects a no-reader FIFO swapped in before %s advanced append",
    async (variant) => {
      const dir = await tempRoot("fs-safe-append-write-fifo-");
      const filePath = path.join(dir, "value");
      const displaced = `${filePath}.displaced`;
      await fs.writeFile(filePath, "ORIGINAL");
      const probe = await fs.open(filePath, "r");
      const prototype = Object.getPrototypeOf(probe);
      await probe.close();
      const chmod = vi.spyOn(prototype, "chmod");
      const append = vi.spyOn(prototype, "appendFile");
      const fchmod = vi.spyOn(fsSync, "fchmodSync");
      const write = vi.spyOn(fsSync, "writeSync");
      let fifoStat: fsSync.Stats | undefined;
      const swap = (candidate: string) => {
        expect(candidate).toBe(filePath);
        fsSync.renameSync(filePath, displaced);
        fifoStat = makeFifo(filePath);
      };
      __setFsSafeTestHooksForTest({
        beforeRegularFileAppendOpen: swap,
        beforeRegularFileAppendOpenSync: swap,
      });
      const refusal = new Error(`Refusing to append to non-file: ${filePath}`);
      if (variant === "async") {
        const realOpen = fs.open.bind(fs);
        const open = vi.spyOn(fs, "open").mockImplementationOnce(async (candidate, flags, mode) => {
          expectNonblocking(flags);
          expectWriteOnly(flags);
          return await realOpen(candidate, flags, mode);
        });
        await expect(appendRegularFile({ filePath, content: "MUTATED" })).rejects.toEqual(refusal);
        expect(open).toHaveBeenCalledTimes(1);
      } else {
        const realOpen = fsSync.openSync.bind(fsSync);
        const open = vi.spyOn(fsSync, "openSync").mockImplementationOnce((candidate, flags, mode) => {
          expectNonblocking(flags);
          expectWriteOnly(flags);
          return realOpen(candidate, flags, mode);
        });
        expect(() => appendRegularFileSync({ filePath, content: "MUTATED" }))
          .toThrow(expect.objectContaining({ message: refusal.message }));
        expect(open).toHaveBeenCalledTimes(1);
      }
      expect(fifoStat).toBeDefined();
      expect(fsSync.lstatSync(filePath)).toEqual(fifoStat);
      expect(chmod).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(fchmod).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(fsSync.readFileSync(displaced, "utf8")).toBe("ORIGINAL");
      expect(fsSync.readdirSync(dir).sort()).toEqual(["value", "value.displaced"]);
    },
  );

  itPosix.each(["replace", "update", "append", "async", "sync"] as const)(
    "preserves ordinary %s writes and required access modes",
    async (operation) => {
      const dir = await tempRoot("fs-safe-write-only-control-");
      const filePath = path.join(dir, "value");
      const mode = operation === "append" ? 0o600 : 0o200;
      await fs.writeFile(filePath, "ORIGINAL", { mode });
      await fs.chmod(filePath, mode);
      const scoped = await openRoot(dir);
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementationOnce(async (candidate, flags, permissions) => {
        expectNonblocking(flags);
        if (operation !== "append") expectWriteOnly(flags);
        expect(Number(flags) & constants.O_TRUNC).toBe(0);
        return await realOpen(candidate, flags, permissions);
      });
      if (operation === "sync") {
        const realOpenSync = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementationOnce((candidate, flags, permissions) => {
          expectNonblocking(flags);
          expectWriteOnly(flags);
          return realOpenSync(candidate, flags, permissions);
        });
        appendRegularFileSync({ filePath, content: "X", mode });
      } else if (operation === "async") {
        await appendRegularFile({ filePath, content: "X", mode });
      } else {
        const opened = await scoped.openWritable("value", { writeMode: operation, mkdir: false });
        try {
          expect(opened.createdForWrite).toBe(false);
          await opened.handle.writeFile("X");
        } finally {
          await opened.handle.close();
        }
      }
      expect(fsSync.statSync(filePath).mode & 0o777).toBe(mode);
      await fs.chmod(filePath, 0o600);
      const expected = operation === "replace" ? "X" : operation === "update" ? "XRIGINAL" : "ORIGINALX";
      expect(fsSync.readFileSync(filePath, "utf8")).toBe(expected);
    },
  );

  it.each(["replace", "update", "append"] as const)(
    "keeps Root %s creation exclusive and unchanged",
    async (writeMode) => {
      const dir = await tempRoot("fs-safe-write-create-flags-");
      const scoped = await openRoot(dir);
      const realOpen = fs.open.bind(fs);
      const noFollow = process.platform !== "win32" ? constants.O_NOFOLLOW ?? 0 : 0;
      const access = writeMode === "append" ? constants.O_RDWR | constants.O_APPEND : constants.O_WRONLY;
      const open = vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
        const expected = access | noFollow | (open.mock.calls.length === 1
          ? resolveNonblockingWriteFlag() : constants.O_CREAT | constants.O_EXCL);
        expect(flags).toBe(expected);
        return await realOpen(candidate, flags, mode);
      });
      const opened = await scoped.openWritable("new", { writeMode, mkdir: false });
      try {
        expect(opened.createdForWrite).toBe(true);
        await opened.handle.writeFile("created");
      } finally {
        await opened.handle.close();
      }
      expect(open).toHaveBeenCalledTimes(2);
      expect(await fs.readFile(path.join(dir, "new"), "utf8")).toBe("created");
    },
  );

  itPosix("keeps delayed truncation and existing-path cleanup fencing after a regular-file swap", async () => {
    const dir = await tempRoot("fs-safe-write-truncate-fence-");
    const filePath = path.join(dir, "value");
    const displaced = `${filePath}.displaced`;
    await fs.writeFile(filePath, "ORIGINAL");
    const scoped = await openRoot(dir);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (candidate, flags, mode) => {
      expectNonblocking(flags);
      expect(Number(flags) & constants.O_TRUNC).toBe(0);
      const handle = await realOpen(candidate, flags, mode);
      await fs.rename(filePath, displaced);
      await fs.writeFile(filePath, "REPLACEMENT");
      return handle;
    });
    await expect(scoped.openWritable("value", { mkdir: false })).rejects.toMatchObject({
      code: "path-mismatch", message: "path changed during write",
    });
    expect(await fs.readFile(filePath, "utf8")).toBe("REPLACEMENT");
    expect(await fs.readFile(displaced, "utf8")).toBe("ORIGINAL");
  });

  for (const operation of ["replace", "update", "async", "sync"] as const) {
    itPosix.each(["regular", "missing", "uninspectable", "other-errno"] as const)(
      `preserves the original ${operation} error for %s paths`,
      async (state) => {
        const dir = await tempRoot("fs-safe-write-enxio-");
        const filePath = path.join(dir, "value");
        await fs.writeFile(filePath, "ORIGINAL");
        const scoped = await openRoot(dir);
        const failure = Object.assign(new Error("open failed"), {
          code: state === "other-errno" ? "EIO" : "ENXIO",
        });
        const failOpen = () => {
          if (state === "missing") fsSync.unlinkSync(filePath);
          if (state === "other-errno") {
            fsSync.renameSync(filePath, `${filePath}.displaced`);
            fsSync.mkdirSync(filePath);
          }
          if (state === "uninspectable") {
            const denied = Object.assign(new Error("inspection denied"), { code: "EACCES" });
            vi.spyOn(fs, "lstat").mockRejectedValueOnce(denied);
            vi.spyOn(fsSync, "lstatSync").mockImplementationOnce(() => { throw denied; });
          }
          throw failure;
        };
        if (operation === "sync") {
          vi.spyOn(fsSync, "openSync").mockImplementationOnce(failOpen);
          let caught: unknown;
          try {
            appendRegularFileSync({ filePath, content: "X" });
          } catch (error) {
            caught = error;
          }
          expect(caught).toBe(failure);
        } else {
          vi.spyOn(fs, "open").mockImplementationOnce(async () => failOpen());
          const pending = operation === "async"
            ? appendRegularFile({ filePath, content: "X" })
            : scoped.openWritable("value", { writeMode: operation, mkdir: false });
          await expect(pending).rejects.toBe(failure);
        }
      },
    );
  }

  itPosix("preserves ENXIO from Root read-write append even for a non-regular path", async () => {
    const dir = await tempRoot("fs-safe-write-rdwr-enxio-");
    makeFifo(path.join(dir, "fifo"));
    const scoped = await openRoot(dir);
    const failure = Object.assign(new Error("open failed"), { code: "ENXIO" });
    vi.spyOn(fs, "open").mockRejectedValueOnce(failure);
    await expect(scoped.openWritable("fifo", { writeMode: "append", mkdir: false }))
      .rejects.toBe(failure);
  });
});

describe("writable admission platform flags", () => {
  itPosix("classifies ENXIO using the current entry without following symlinks", async () => {
    const dir = await tempRoot("fs-safe-write-enxio-lstat-");
    const target = path.join(dir, "target");
    const link = path.join(dir, "link");
    await fs.writeFile(target, "ORIGINAL");
    await fs.symlink(target, link);
    const error = Object.assign(new Error("open failed"), { code: "ENXIO" });
    const flags = constants.O_WRONLY | constants.O_NONBLOCK;
    expect(await isNonRegularWriteOpenError(error, link, flags)).toBe(true);
    expect(isNonRegularWriteOpenErrorSync(error, link, flags)).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("ORIGINAL");
    expect(fsSync.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it.each(["linux", "darwin", "win32"] as const)("resolves %s append flags", (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const base = { O_WRONLY: 1, O_APPEND: 2, O_CREAT: 4 };
    expect(resolveRegularFileAppendFlags(base)).toBe(7);
    expect(resolveRegularFileAppendFlags({ ...base, O_NOFOLLOW: 8 })).toBe(15);
    expect(resolveRegularFileAppendFlags({ ...base, O_NONBLOCK: 16 })).toBe(platform === "win32" ? 7 : 23);
    expect(resolveRegularFileAppendFlags({ ...base, O_NOFOLLOW: 8, O_NONBLOCK: 16 }))
      .toBe(platform === "win32" ? 15 : 31);
  });

  it.each(["linux", "win32"] as const)("does not inspect unrelated %s open errors", async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const lstat = vi.spyOn(fs, "lstat");
    const lstatSync = vi.spyOn(fsSync, "lstatSync");
    const enxio = Object.assign(new Error("open failed"), { code: "ENXIO" });
    const flags = [constants.O_WRONLY, constants.O_RDONLY | constants.O_NONBLOCK,
      constants.O_RDWR | constants.O_NONBLOCK];
    if (platform === "win32") flags.push(constants.O_WRONLY | constants.O_NONBLOCK);
    for (const flag of flags) {
      expect(await isNonRegularWriteOpenError(enxio, "unused", flag)).toBe(false);
      expect(isNonRegularWriteOpenErrorSync(enxio, "unused", flag)).toBe(false);
    }
    expect(lstat).not.toHaveBeenCalled();
    expect(lstatSync).not.toHaveBeenCalled();
  });
});
