import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync, withFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const ROOT_SYNC_HELD_LOCKS_KEY = Symbol.for("fsSafe.syncRootSidecarLocks.v1");

type RootSyncHeldLockView = {
  deferredExitReleases?: Set<object>;
  fd: number | undefined;
  refCount: number;
  releaseState: string;
  revision: number;
};

function rootSyncHeldLocks(): Map<string, RootSyncHeldLockView> {
  return Reflect.get(globalThis, ROOT_SYNC_HELD_LOCKS_KEY) as Map<string, RootSyncHeldLockView>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("synchronous Root-backed scoped release settlement", () => {
  it("surrenders only a balanced scoped handle pending during exit cleanup", async () => {
    const directory = await tempRoot("fs-safe-sync-root-exit-scoped-settle-");
    const target = path.join(directory, "state.json");
    const owner = "same-owner";
    let armed = false;
    let authorityCallbacks = 0;
    let scopedRuns = 0;
    let scopedResult: string | undefined;
    let original: ReturnType<typeof acquireFileLockSync> | undefined;
    let retained: ReturnType<typeof acquireFileLockSync> | undefined;
    const lockRoot = await root(directory, {
      assertBeforeMutation: () => {
        authorityCallbacks += 1;
        if (!armed) return;
        armed = false;
        original!.release();
        original!.release();
        scopedResult = withFileLockSync(target, {
          lockRoot,
          payload: () => ({ owner: "scoped" }),
          reentrantOwner: owner,
        }, () => {
          scopedRuns += 1;
          return "scoped-result";
        });
        original!.release();
        retained = acquireFileLockSync(target, {
          lockRoot,
          payload: () => ({ owner: "retained" }),
          reentrantOwner: owner,
        });
      },
    });
    original = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "original" }),
      reentrantOwner: owner,
    });
    const cleanup = Reflect.get(
      globalThis,
      Symbol.for("fsSafe.syncRootSidecarLockCleanupHandler.v1"),
    ) as () => void;
    const heldLocks = rootSyncHeldLocks();
    const held = heldLocks.get(original.normalizedTargetPath);
    if (!held) throw new Error("expected held Root lock entry");
    const initialRevision = held.revision;
    const callbackBaseline = authorityCallbacks;
    const open = vi.spyOn(fs, "openSync");
    const close = vi.spyOn(fs, "closeSync");
    try {
      armed = true;
      cleanup();
      // One exit-removal callback plus one admission each for the scoped and
      // retained handles. A cleanup retry would add another callback.
      expect(authorityCallbacks - callbackBaseline).toBe(3);
      expect(scopedRuns).toBe(1);
      expect(scopedResult).toBe("scoped-result");
      expect(heldLocks.get(original.normalizedTargetPath)).toBe(held);
      expect(held).toMatchObject({
        deferredExitReleases: undefined,
        fd: undefined,
        refCount: 2,
        releaseState: "active",
        revision: initialRevision + 6,
      });
      expect(close.mock.calls.length - open.mock.calls.length).toBe(1);
      expect(fs.existsSync(original.lockPath)).toBe(true);

      original.release();
      const revisionAfterOriginal = held.revision;
      expect(held.refCount).toBe(1);
      expect(fs.existsSync(original.lockPath)).toBe(true);
      original.release();
      expect(held.refCount).toBe(1);
      expect(held.revision).toBe(revisionAfterOriginal);
      expect(retained!.verifyStillHeld()).toBe(true);
      expect(close.mock.calls.length - open.mock.calls.length).toBe(1);

      retained!.release();
      expect(heldLocks.has(original.normalizedTargetPath)).toBe(false);
      expect(fs.existsSync(original.lockPath)).toBe(false);
      expect(close.mock.calls.length - open.mock.calls.length).toBe(1);
    } finally {
      armed = false;
      retained?.release();
      original.release();
      if (fs.existsSync(original.lockPath)) fs.unlinkSync(original.lockPath);
    }
  });

  it("settles a deferred scoped handle when its protected callback throws", async () => {
    const directory = await tempRoot("fs-safe-sync-root-exit-scoped-error-");
    const target = path.join(directory, "state.json");
    const owner = "same-owner";
    const callbackFailure = new Error("scoped callback failed");
    let armed = false;
    let authorityCallbacks = 0;
    let observedFailure: unknown;
    let original: ReturnType<typeof acquireFileLockSync> | undefined;
    let retained: ReturnType<typeof acquireFileLockSync> | undefined;
    const lockRoot = await root(directory, {
      assertBeforeMutation: () => {
        authorityCallbacks += 1;
        if (!armed) return;
        armed = false;
        original!.release();
        try {
          withFileLockSync(target, {
            lockRoot,
            payload: () => ({ owner: "scoped" }),
            reentrantOwner: owner,
          }, () => {
            throw callbackFailure;
          });
        } catch (error) {
          observedFailure = error;
        }
        retained = acquireFileLockSync(target, {
          lockRoot,
          payload: () => ({ owner: "retained" }),
          reentrantOwner: owner,
        });
      },
    });
    original = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "original" }),
      reentrantOwner: owner,
    });
    const cleanup = Reflect.get(
      globalThis,
      Symbol.for("fsSafe.syncRootSidecarLockCleanupHandler.v1"),
    ) as () => void;
    const heldLocks = rootSyncHeldLocks();
    const held = heldLocks.get(original.normalizedTargetPath);
    if (!held) throw new Error("expected held Root lock entry");
    const initialRevision = held.revision;
    const callbackBaseline = authorityCallbacks;
    try {
      armed = true;
      cleanup();
      expect(observedFailure).toBe(callbackFailure);
      expect(authorityCallbacks - callbackBaseline).toBe(3);
      expect(heldLocks.get(original.normalizedTargetPath)).toBe(held);
      expect(held).toMatchObject({
        deferredExitReleases: undefined,
        fd: undefined,
        refCount: 2,
        releaseState: "active",
        revision: initialRevision + 6,
      });
      expect(fs.existsSync(original.lockPath)).toBe(true);

      original.release();
      expect(held.refCount).toBe(1);
      expect(fs.existsSync(original.lockPath)).toBe(true);
      expect(retained!.verifyStillHeld()).toBe(true);
      retained!.release();
      expect(heldLocks.has(original.normalizedTargetPath)).toBe(false);
      expect(fs.existsSync(original.lockPath)).toBe(false);
    } finally {
      armed = false;
      retained?.release();
      original.release();
      if (fs.existsSync(original.lockPath)) fs.unlinkSync(original.lockPath);
    }
  });
});
