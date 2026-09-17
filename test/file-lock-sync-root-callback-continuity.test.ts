import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { pathForWindowsFilesystem } from "../src/windows-path-alias.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const immediate = { timeoutMs: 0, retry: { retries: 0 } } as const;
const ROOT_SYNC_HELD_LOCKS_KEY = Symbol.for("fsSafe.syncRootSidecarLocks.v1");

type RootSyncHeldLockView = {
  fd: number | undefined;
  lockPath: string;
  refCount: number;
  releaseState: string;
  timer?: NodeJS.Timeout;
};

function rootSyncHeldLocks(): Map<string, RootSyncHeldLockView> {
  return Reflect.get(globalThis, ROOT_SYNC_HELD_LOCKS_KEY) as Map<string, RootSyncHeldLockView>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("synchronous Root callback continuity", () => {
  it("does not return a released entry after its parser enters exit cleanup", async () => {
    const directory = await tempRoot("fs-safe-sync-root-parser-cleanup-");
    const target = path.join(directory, "state.json");
    const lockRoot = await root(directory);
    let armed = false;
    let blockRemoval = false;
    let parserCalls = 0;
    const parsePayload = (raw: string) => {
      parserCalls += 1;
      if (armed) {
        armed = false;
        blockRemoval = true;
        const cleanup = Reflect.get(
          globalThis,
          Symbol.for("fsSafe.syncRootSidecarLockCleanupHandler.v1"),
        ) as () => void;
        cleanup();
        blockRemoval = false;
      }
      return JSON.parse(raw) as unknown;
    };
    const original = acquireFileLockSync(target, {
      lockRoot,
      parsePayload,
      payload: () => ({ owner: "original" }),
      reentrantOwner: "same-owner",
    });
    const realRm = fs.rmSync.bind(fs);
    const removeFailure = Object.assign(new Error("exit removal blocked"), { code: "EACCES" });
    vi.spyOn(fs, "rmSync").mockImplementation((candidate, ...args) => {
      if (blockRemoval && String(candidate) === pathForWindowsFilesystem(original.lockPath)) {
        throw removeFailure;
      }
      return realRm(candidate, ...args);
    });
    try {
      armed = true;
      expect(() => acquireFileLockSync(target, {
        ...immediate,
        lockRoot,
        parsePayload,
        payload: () => ({ owner: "nested" }),
        reentrantOwner: "same-owner",
      })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(parserCalls).toBe(1);
      expect(rootSyncHeldLocks().has(original.normalizedTargetPath)).toBe(false);
      expect(fs.existsSync(original.lockPath)).toBe(true);
    } finally {
      armed = false;
      blockRemoval = false;
      original.release();
      if (fs.existsSync(original.lockPath)) fs.unlinkSync(original.lockPath);
    }
  });

  it.each([
    ["same owner", "same-owner", "same-owner", false, true],
    ["different owner", "outer-owner", "nested-owner", false, false],
    ["no owner", undefined, undefined, false, false],
    ["different lock path", "same-owner", "same-owner", true, false],
  ] as const)(
    "arbitrates a lock published by payload serialization for %s",
    async (_label, outerOwner, nestedOwner, differentLockPath, shouldReuse) => {
      const directory = await tempRoot("fs-safe-sync-root-payload-collision-");
      const target = path.join(directory, "state.json");
      const outerLockPath = path.join(directory, "outer.lock");
      const nestedLockPath = differentLockPath
        ? path.join(directory, "nested.lock")
        : outerLockPath;
      let mutationCallbacks = 0;
      const lockRoot = await root(directory, {
        assertBeforeMutation: () => {
          mutationCallbacks += 1;
        },
      });
      const nestedPayload = vi.fn(() => ({ owner: "nested" }));
      let nested: ReturnType<typeof acquireFileLockSync> | undefined;
      const outerPayload = vi.fn(() => ({
        owner: "outer",
        toJSON: () => {
          nested = acquireFileLockSync(target, {
            ...immediate,
            lockPath: nestedLockPath,
            lockRoot,
            payload: nestedPayload,
            ...(nestedOwner === undefined ? {} : { reentrantOwner: nestedOwner }),
          });
          return { owner: "outer" };
        },
      }));
      let outer: ReturnType<typeof acquireFileLockSync> | undefined;
      let outerError: unknown;
      try {
        try {
          outer = acquireFileLockSync(target, {
            ...immediate,
            lockPath: outerLockPath,
            lockRoot,
            payload: outerPayload,
            ...(outerOwner === undefined ? {} : { reentrantOwner: outerOwner }),
          });
        } catch (error) {
          outerError = error;
        }
        expect(outerPayload).toHaveBeenCalledTimes(1);
        expect(nestedPayload).toHaveBeenCalledTimes(1);
        // Outer admission is authorized before its payload. Serialization
        // reenters for nested admission and that nested exclusive create; the
        // outer create must never add a fourth authority callback.
        expect(mutationCallbacks).toBe(3);
        expect(nested).toBeDefined();
        const held = rootSyncHeldLocks().get(nested!.normalizedTargetPath);
        expect(held?.lockPath).toBe(nestedLockPath);
        if (shouldReuse) {
          expect(outerError).toBeUndefined();
          expect(outer?.lockPath).toBe(nestedLockPath);
          expect(held?.refCount).toBe(2);
        } else {
          expect(outer).toBeUndefined();
          expect(outerError).toMatchObject({ code: "file_lock_timeout" });
          expect(held?.refCount).toBe(1);
        }
        expect(nested!.verifyStillHeld()).toBe(true);
        expect(fs.existsSync(outerLockPath)).toBe(!differentLockPath);
      } finally {
        outer?.release();
        nested?.release();
        if (fs.existsSync(outerLockPath)) fs.unlinkSync(outerLockPath);
        if (fs.existsSync(nestedLockPath)) fs.unlinkSync(nestedLockPath);
      }
    },
  );

  it("reuses the exact nested entry after same-path EEXIST", async () => {
    const directory = await tempRoot("fs-safe-sync-root-eexist-collision-");
    const target = path.join(directory, "state.json");
    const lockPath = path.join(directory, "state.lock");
    const operationPath = pathForWindowsFilesystem(lockPath);
    const lockRoot = await root(directory);
    const realOpen = fs.openSync.bind(fs);
    let inject = true;
    let nested: ReturnType<typeof acquireFileLockSync> | undefined;
    const nestedPayload = vi.fn(() => ({ owner: "nested" }));
    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      if (inject && String(candidate) === operationPath && typeof flags === "number" &&
        (flags & fs.constants.O_EXCL) !== 0) {
        inject = false;
        nested = acquireFileLockSync(target, {
          lockPath,
          lockRoot,
          payload: nestedPayload,
          reentrantOwner: "same-owner",
        });
      }
      return realOpen(candidate, flags, mode);
    });
    const outerPayload = vi.fn(() => ({ owner: "outer" }));
    const outer = acquireFileLockSync(target, {
      lockPath,
      lockRoot,
      payload: outerPayload,
      reentrantOwner: "same-owner",
    });
    try {
      expect(nested).toBeDefined();
      expect(outerPayload).toHaveBeenCalledTimes(1);
      expect(nestedPayload).toHaveBeenCalledTimes(1);
      expect(rootSyncHeldLocks().get(outer.normalizedTargetPath)?.refCount).toBe(2);
      expect(outer.verifyStillHeld()).toBe(true);
    } finally {
      outer.release();
      nested?.release();
    }
  });

  it("fences a Root mutation callback before opening a colliding sidecar", async () => {
    const directory = await tempRoot("fs-safe-sync-root-preopen-collision-");
    const target = path.join(directory, "state.json");
    const outerLockPath = path.join(directory, "outer.lock");
    const nestedLockPath = path.join(directory, "nested.lock");
    let armed = false;
    let nested: ReturnType<typeof acquireFileLockSync> | undefined;
    const lockRoot = await root(directory, {
      assertBeforeMutation: () => {
        if (!armed) return;
        armed = false;
        nested = acquireFileLockSync(target, {
          lockPath: nestedLockPath,
          lockRoot,
          payload: () => ({ owner: "nested" }),
          reentrantOwner: "same-owner",
        });
      },
    });
    const open = vi.spyOn(fs, "openSync");
    let error: unknown;
    try {
      try {
        acquireFileLockSync(target, {
          ...immediate,
          lockPath: outerLockPath,
          lockRoot,
          payload: () => {
            armed = true;
            return { owner: "outer" };
          },
          reentrantOwner: "same-owner",
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "file_lock_timeout" });
      expect(nested?.verifyStillHeld()).toBe(true);
      expect(fs.existsSync(outerLockPath)).toBe(false);
      expect(open.mock.calls.some(([candidate]) =>
        String(candidate) === pathForWindowsFilesystem(outerLockPath))).toBe(false);
    } finally {
      armed = false;
      nested?.release();
    }
  });

  it("removes only the local sidecar after a late publication collision", async () => {
    const directory = await tempRoot("fs-safe-sync-root-publish-cleanup-");
    const target = path.join(directory, "state.json");
    const outerLockPath = path.join(directory, "outer.lock");
    const nestedLockPath = path.join(directory, "nested.lock");
    const lockRoot = await root(directory);
    let armed = true;
    let nested: ReturnType<typeof acquireFileLockSync> | undefined;
    const realFsync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      realFsync(fd);
      if (!armed) return;
      armed = false;
      nested = acquireFileLockSync(target, {
        lockPath: nestedLockPath,
        lockRoot,
        payload: () => ({ owner: "nested" }),
        reentrantOwner: "same-owner",
      });
    });
    let error: unknown;
    try {
      try {
        acquireFileLockSync(target, {
          ...immediate,
          lockPath: outerLockPath,
          lockRoot,
          payload: () => ({ owner: "outer" }),
          reentrantOwner: "same-owner",
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "file_lock_timeout" });
      const held = rootSyncHeldLocks().get(nested!.normalizedTargetPath);
      expect(held).toMatchObject({ lockPath: nestedLockPath, refCount: 1, releaseState: "active" });
      expect(fs.existsSync(outerLockPath)).toBe(false);
      expect(fs.existsSync(nestedLockPath)).toBe(true);
      expect(nested!.verifyStillHeld()).toBe(true);
      expect(() => fs.fstatSync(held!.fd!)).not.toThrow();
    } finally {
      nested?.release();
      if (fs.existsSync(outerLockPath)) fs.unlinkSync(outerLockPath);
    }
  });

  it("keeps a published successor intact when local collision cleanup fails", async () => {
    const directory = await tempRoot("fs-safe-sync-root-publish-collision-");
    const target = path.join(directory, "state.json");
    const outerLockPath = path.join(directory, "outer.lock");
    const nestedLockPath = path.join(directory, "nested.lock");
    const lockRoot = await root(directory);
    let armed = true;
    let nested: ReturnType<typeof acquireFileLockSync> | undefined;
    const realFsync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      realFsync(fd);
      if (!armed) return;
      armed = false;
      nested = acquireFileLockSync(target, {
        lockPath: nestedLockPath,
        lockRoot,
        payload: () => ({ owner: "nested" }),
        reentrantOwner: "same-owner",
        compromiseCheckIntervalMs: 60_000,
        onCompromised: () => {},
      });
    });
    const cleanupFailure = Object.assign(new Error("local cleanup blocked"), { code: "EACCES" });
    const realRm = fs.rmSync.bind(fs);
    vi.spyOn(fs, "rmSync").mockImplementation((candidate, ...args) => {
      if (String(candidate) === pathForWindowsFilesystem(outerLockPath)) throw cleanupFailure;
      return realRm(candidate, ...args);
    });
    const realOpen = fs.openSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    let outerCreatedFd: number | undefined;
    let outerFdOwned = false;
    let outerOwnedCloseCount = 0;
    let nestedCreatedFd: number | undefined;
    let nestedFdOwned = false;
    let nestedOwnedCloseCount = 0;
    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const fd = realOpen(candidate, flags, mode);
      if (typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0) {
        if (String(candidate) === pathForWindowsFilesystem(outerLockPath)) {
          outerCreatedFd = fd;
          outerFdOwned = true;
        } else if (String(candidate) === pathForWindowsFilesystem(nestedLockPath)) {
          nestedCreatedFd = fd;
          nestedFdOwned = true;
        }
      }
      return fd;
    });
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      if (outerFdOwned && fd === outerCreatedFd) {
        outerFdOwned = false;
        outerOwnedCloseCount += 1;
      }
      if (nestedFdOwned && fd === nestedCreatedFd) {
        nestedFdOwned = false;
        nestedOwnedCloseCount += 1;
      }
      return realClose(fd);
    });
    let error: unknown;
    try {
      try {
        acquireFileLockSync(target, {
          ...immediate,
          lockPath: outerLockPath,
          lockRoot,
          payload: () => ({ owner: "outer" }),
          reentrantOwner: "same-owner",
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        name: "SuppressedError",
        error: { code: "path-mismatch" },
        suppressed: cleanupFailure,
      });
      const held = rootSyncHeldLocks().get(nested!.normalizedTargetPath);
      expect(held).toMatchObject({
        lockPath: nestedLockPath,
        refCount: 1,
        releaseState: "active",
      });
      expect(held?.timer).toBeDefined();
      expect(held?.fd).toBe(nestedCreatedFd);
      expect(outerOwnedCloseCount).toBe(1);
      expect(nestedOwnedCloseCount).toBe(0);
      expect(nested!.verifyStillHeld()).toBe(true);
      expect(outerCreatedFd).toBeTypeOf("number");
      expect(fs.existsSync(outerLockPath)).toBe(true);
      nested!.release();
      nested = undefined;
      expect(nestedOwnedCloseCount).toBe(1);
    } finally {
      nested?.release();
      if (fs.existsSync(outerLockPath)) fs.unlinkSync(outerLockPath);
    }
  });
});
