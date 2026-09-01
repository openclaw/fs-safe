import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const defaults = {
  payload: () => ({ pid: process.pid }),
  staleMs: 60_000,
  timeoutMs: 1_000,
  retry: { retries: 20, minTimeout: 0, maxTimeout: 0 },
};
const failure = (pathname: string, code = "EPERM") =>
  Object.assign(new Error("injected filesystem failure"), { code, path: pathname, syscall: "open" });
const exclusive = (flags: string | number) => typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0;

async function fixture(rooted = false) {
  const directory = await tempRoot("fs-safe-sync-denial-");
  const lockRoot = rooted ? await root(directory) : undefined;
  const target = path.join(directory, "state");
  // Exercise Windows classification on every host, using real local descriptors.
  Object.defineProperty(process, "platform", { value: "win32" });
  return { directory, target, lockPath: `${target}.lock`, options: { ...defaults, lockRoot } };
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

describe("synchronous Windows lock-file open denials", () => {
  it.each([
    [false, "create"], [true, "create"], [false, "snapshot"], [true, "snapshot"],
  ] as const)("retries only fresh exclusive creation after a denial (Root: %s, %s)", async (rooted, stage) => {
    const { target, lockPath, options } = await fixture(rooted);
    if (stage === "snapshot") fs.writeFileSync(lockPath, "{}");
    const open = fs.openSync.bind(fs);
    const parsePayload = vi.fn(JSON.parse);
    let creates = 0, denials = 0;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (file === lockPath) {
        if (exclusive(flags)) creates += 1;
        if (!denials && exclusive(flags) === (stage === "create")) {
          denials += 1;
          if (stage === "snapshot") fs.unlinkSync(lockPath);
          throw failure(lockPath);
        }
      }
      return open(file, flags, mode);
    });
    const lock = acquireFileLockSync(target, { ...options, parsePayload });
    try {
      expect(creates).toBe(2);
      expect(denials).toBe(1);
      expect(parsePayload).not.toHaveBeenCalled();
      expect(lock.verifyStillHeld()).toBe(true);
    } finally {
      lock.release();
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  for (const stage of ["create", "snapshot"] as const) {
    it.each([
      { name: "internal cap", retries: undefined, timeoutMs: Infinity, attempts: 9 },
      { name: "zero retries", retries: 0, timeoutMs: Infinity, attempts: 1 },
      { name: "caller retry cap", retries: 2, timeoutMs: Infinity, attempts: 3 },
      { name: "caller deadline", retries: 20, timeoutMs: 0, attempts: 1 },
    ])(`preserves the last ${stage} denial at $name`, async ({ retries, timeoutMs, attempts }) => {
      const { target, lockPath, options } = await fixture();
      if (stage === "snapshot") fs.writeFileSync(lockPath, "{}");
      const open = fs.openSync.bind(fs);
      let denied = 0, lastError: Error | undefined;
      vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
        if (file === lockPath && exclusive(flags) === (stage === "create")) {
          denied += 1;
          lastError = failure(lockPath);
          throw lastError;
        }
        return open(file, flags, mode);
      });
      const payload = vi.fn(options.payload), shouldReclaim = vi.fn(() => false);
      let caught: unknown;
      try {
        acquireFileLockSync(target, {
          ...options, payload, shouldReclaim, timeoutMs,
          retry: { retries, minTimeout: 0, maxTimeout: 0 },
        });
      } catch (error) { caught = error; }
      expect(caught).toBe(lastError);
      expect(denied).toBe(attempts);
      expect(payload).toHaveBeenCalledTimes(attempts);
      expect(shouldReclaim).not.toHaveBeenCalled();
      expect(fs.existsSync(lockPath)).toBe(stage === "snapshot");
    });
  }

  it("shares the denial cap across create and snapshot opens", async () => {
    const { target, lockPath, options } = await fixture();
    const open = fs.openSync.bind(fs);
    let denials = 0;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (file === lockPath && (denials < 4 || !exclusive(flags))) {
        denials += 1;
        if (denials === 4) fs.writeFileSync(lockPath, "{}");
        throw failure(lockPath);
      }
      return open(file, flags, mode);
    });
    expect(() => acquireFileLockSync(target, options)).toThrow(expect.objectContaining({ code: "EPERM" }));
    expect(denials).toBe(9);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("{}");
  });

  it.each(["create", "snapshot"])("does not retry POSIX %s denials or denials without the exact lock path", async (stage) => {
    const { directory, target, lockPath, options } = await fixture();
    if (stage === "snapshot") fs.writeFileSync(lockPath, "{}");
    const open = fs.openSync.bind(fs);
    for (const [system, pathname, code] of [
      ["linux", lockPath, "EPERM"], ["win32", directory, "EPERM"],
      ["win32", undefined, "EPERM"], ["win32", lockPath, "EACCES"],
    ] as const) {
      Object.defineProperty(process, "platform", { value: system });
      const error = Object.assign(failure(lockPath, code), { path: pathname });
      let calls = 0;
      const spy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
        if (file === lockPath && exclusive(flags) === (stage === "create")) {
          calls += 1;
          throw error;
        }
        return open(file, flags, mode);
      });
      expect(() => acquireFileLockSync(target, options)).toThrow(error);
      expect(calls).toBe(1);
      spy.mockRestore();
    }
  });

  it.each(["payload", "parser", "read", "fstat", "parent", "write", "fsync"])(
    "propagates caller/read/stat errors without retry or ENOENT suppression (%s)", async (stage) => {
      for (const code of ["EPERM", "ENOENT"]) {
        const { target, lockPath, options } = await fixture();
        if (["parser", "read", "fstat"].includes(stage)) fs.writeFileSync(lockPath, "{}");
        const error = failure(lockPath, code);
        const close = vi.spyOn(fs, "closeSync");
        const fail = vi.fn((): never => { throw error; });
        const payload = stage === "payload" ? fail : vi.fn(options.payload);
        if (stage === "read") vi.spyOn(fs, "readSync").mockImplementationOnce(fail);
        if (stage === "fstat") vi.spyOn(fs, "fstatSync").mockImplementationOnce(fail);
        if (stage === "parent") vi.spyOn(fs, "mkdirSync").mockImplementationOnce(fail);
        if (stage === "write") vi.spyOn(fs, "writeFileSync").mockImplementationOnce(fail);
        if (stage === "fsync") vi.spyOn(fs, "fsyncSync").mockImplementationOnce(fail);
        expect(() => acquireFileLockSync(target, {
          ...options, payload, ...(stage === "parser" ? { parsePayload: fail } : {}),
        })).toThrow(error);
        expect(fail).toHaveBeenCalledTimes(1);
        expect(payload).toHaveBeenCalledTimes(stage === "parent" ? 0 : 1);
        if (["parser", "read", "fstat"].includes(stage)) expect(close).toHaveBeenCalledTimes(1);
        vi.restoreAllMocks();
        expect(fs.existsSync(lockPath)).toBe(["parser", "read", "fstat"].includes(stage));
      }
    },
  );

  it.each([1, 2])("does not classify snapshot lstat %s as an open denial", async (observation) => {
    const { target, lockPath, options } = await fixture();
    fs.writeFileSync(lockPath, "{}");
    const error = failure(lockPath), lstat = fs.lstatSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, "lstatSync").mockImplementation((file, opts) => {
      if (file === lockPath && ++calls === observation) throw error;
      return lstat(file, opts as never);
    });
    const payload = vi.fn(options.payload);
    expect(() => acquireFileLockSync(target, { ...options, payload })).toThrow(error);
    expect(calls).toBe(observation);
    expect(payload).toHaveBeenCalledTimes(1);
  });

  it.each(["verify", "release", "reclaim"])("keeps %s open-denial handling strict", async (stage) => {
    const { target, lockPath, options } = await fixture();
    const error = failure(lockPath), open = fs.openSync.bind(fs);
    let reads = 0;
    const denyReads = () => vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (file === lockPath && !exclusive(flags)) { reads += 1; throw error; }
      return open(file, flags, mode);
    });
    if (stage === "reclaim") {
      fs.writeFileSync(lockPath, "{}");
      expect(() => acquireFileLockSync(target, {
        ...options, shouldReclaim: () => true, staleRecovery: "remove-if-unchanged",
        shouldRemoveStaleLock: () => { denyReads(); return true; },
      })).toThrow(error);
      expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
      expect(fs.readFileSync(lockPath, "utf8")).toBe("{}");
    } else {
      const lock = acquireFileLockSync(target, options);
      const spy = denyReads();
      try {
        expect(() => stage === "verify" ? lock.verifyStillHeld() : lock.release()).toThrow(error);
        expect(fs.existsSync(lockPath)).toBe(true);
      } finally {
        spy.mockRestore();
        lock.release();
      }
      expect(fs.existsSync(lockPath)).toBe(false);
    }
    expect(reads).toBe(1);
  });

  for (const stage of ["before-lstat", "open", "after-lstat", "identity"] as const) {
    it.each([
      { retries: 0, timeoutMs: 1_000, attempts: 1 },
      { retries: 2, timeoutMs: 1_000, attempts: 3 },
      { retries: undefined, timeoutMs: 0, attempts: 1 },
    ])(`charges null ${stage} snapshots to caller retries/deadlines ($retries, $timeoutMs)`, async (budget) => {
      const { target, lockPath, options } = await fixture();
      fs.writeFileSync(lockPath, "{}");
      const missing = failure(lockPath, "ENOENT");
      if (stage === "open") {
        const open = fs.openSync.bind(fs);
        vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
          if (file === lockPath && !exclusive(flags)) throw missing;
          return open(file, flags, mode);
        });
      } else if (stage === "identity") {
        // Large Windows inode numbers can round away +1; use distinct known identities.
        const lstat = fs.lstatSync.bind(fs), fstat = fs.fstatSync.bind(fs);
        vi.spyOn(fs, "lstatSync").mockImplementation((file, opts) => {
          const stat = lstat(file, opts as never);
          return file === lockPath ? Object.assign(stat, { ino: 1 }) : stat;
        });
        vi.spyOn(fs, "fstatSync").mockImplementation((fd) => Object.assign(fstat(fd), { ino: 2 }));
      } else {
        const lstat = fs.lstatSync.bind(fs);
        let calls = 0;
        vi.spyOn(fs, "lstatSync").mockImplementation((file, opts) => {
          if (file === lockPath && (++calls % 2 === 0 || stage === "before-lstat")) throw missing;
          return lstat(file, opts as never);
        });
      }
      let attempts = 0;
      const parsePayload = vi.fn(JSON.parse);
      expect(() => acquireFileLockSync(target, {
        ...options, parsePayload, timeoutMs: budget.timeoutMs,
        retry: { retries: budget.retries, minTimeout: 0, maxTimeout: 0 },
        payload: () => {
          // Bound the regression itself: an unbudgeted sync loop blocks test timeouts.
          if (++attempts > budget.attempts + 1) throw new Error("unbounded null-snapshot loop");
          return {};
        },
      })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
      expect(attempts).toBe(budget.attempts);
      expect(parsePayload).not.toHaveBeenCalled();
      expect(fs.readFileSync(lockPath, "utf8")).toBe("{}");
    });
  }
});
