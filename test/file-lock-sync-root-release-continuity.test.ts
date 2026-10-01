import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync, withFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const immediate = { timeoutMs: 0, retry: { retries: 0 } } as const;
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

describe("synchronous Root-backed release continuity", () => {
  it("retries final cleanup after a balanced same-owner acquire and release", async () => {
    const directory = await tempRoot("fs-safe-sync-root-release-balanced-");
    const target = path.join(directory, "state.json");
    const owner = "balanced-owner";
    const nestedPayload = vi.fn(() => ({ owner: "nested" }));
    let armed = false;
    let callbackActive = false;
    let nestedReleases = 0;
    const lockRoot = await root(directory, {
      assertBeforeMutation: () => {
        if (!armed || callbackActive) return;
        armed = false;
        callbackActive = true;
        try {
          const nested = acquireFileLockSync(target, {
            lockRoot,
            payload: nestedPayload,
            reentrantOwner: owner,
          });
          nested.release();
          nestedReleases += 1;
        } finally {
          callbackActive = false;
        }
      },
    });
    const outer = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "outer" }),
      reentrantOwner: owner,
    });
    try {
      armed = true;
      outer.release();
      expect(nestedReleases).toBe(1);
      expect(nestedPayload).not.toHaveBeenCalled();
      expect(fs.existsSync(outer.lockPath)).toBe(false);

      const freshPayload = vi.fn(() => ({ owner: "fresh" }));
      const fresh = acquireFileLockSync(target, { lockRoot, payload: freshPayload });
      try {
        expect(freshPayload).toHaveBeenCalledTimes(1);
      } finally {
        fresh.release();
      }
    } finally {
      armed = false;
      outer.release();
      if (fs.existsSync(outer.lockPath)) fs.unlinkSync(outer.lockPath);
    }
  });

  it("retries final cleanup after a nested same-owner withFileLockSync", async () => {
    const directory = await tempRoot("fs-safe-sync-root-release-with-balanced-");
    const target = path.join(directory, "state.json");
    const owner = "balanced-owner";
    const nestedPayload = vi.fn(() => ({ owner: "nested" }));
    let armed = false;
    let nestedResult: string | undefined;
    const lockRoot = await root(directory, {
      assertBeforeMutation: () => {
        if (!armed) return;
        armed = false;
        nestedResult = withFileLockSync(target, {
          lockRoot,
          payload: nestedPayload,
          reentrantOwner: owner,
        }, () => "nested-result");
      },
    });
    const outer = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "outer" }),
      reentrantOwner: owner,
    });
    try {
      armed = true;
      outer.release();
      expect(nestedResult).toBe("nested-result");
      expect(nestedPayload).not.toHaveBeenCalled();
      expect(fs.existsSync(outer.lockPath)).toBe(false);
    } finally {
      armed = false;
      outer.release();
      if (fs.existsSync(outer.lockPath)) fs.unlinkSync(outer.lockPath);
    }
  });

  it("restores the outer reference when balanced reentry repeatedly interrupts cleanup", async () => {
    const directory = await tempRoot("fs-safe-sync-root-release-repeated-");
    const target = path.join(directory, "state.json");
    const owner = "balanced-owner";
    let armed = false;
    let callbackActive = false;
    let interruptions = 0;
    const lockRoot = await root(directory, {
      assertBeforeMutation: () => {
        if (!armed || callbackActive) return;
        callbackActive = true;
        try {
          const nested = acquireFileLockSync(target, {
            lockRoot,
            payload: () => ({ owner: "nested" }),
            reentrantOwner: owner,
          });
          nested.release();
          interruptions += 1;
        } finally {
          callbackActive = false;
        }
      },
    });
    const outer = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "outer" }),
      reentrantOwner: owner,
    });
    try {
      armed = true;
      expect(() => outer.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(interruptions).toBe(2);
      expect(outer.verifyStillHeld()).toBe(true);
      expect(fs.existsSync(outer.lockPath)).toBe(true);

      armed = false;
      outer.release();
      expect(fs.existsSync(outer.lockPath)).toBe(false);
    } finally {
      armed = false;
      outer.release();
      if (fs.existsSync(outer.lockPath)) fs.unlinkSync(outer.lockPath);
    }
  });

  it("lets exit cleanup finish when its callback releases the original handle", async () => {
    const directory = await tempRoot("fs-safe-sync-root-exit-original-release-");
    const target = path.join(directory, "state.json");
    let armed = false;
    let callbackCalls = 0;
    let original: ReturnType<typeof acquireFileLockSync> | undefined;
    const lockRoot = await root(directory, {
      assertBeforeMutation: () => {
        if (!armed) return;
        callbackCalls += 1;
        original!.release();
      },
    });
    original = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "original" }),
    });
    const cleanup = Reflect.get(
      globalThis,
      Symbol.for("fsSafe.syncRootSidecarLockCleanupHandler.v1"),
    ) as () => void;
    try {
      armed = true;
      cleanup();
      expect(callbackCalls).toBe(2);
      expect(fs.existsSync(original.lockPath)).toBe(false);
      expect(() => original.release()).not.toThrow();
    } finally {
      armed = false;
      original.release();
      if (fs.existsSync(original.lockPath)) fs.unlinkSync(original.lockPath);
    }
  });

  it.each([
    { name: "retained successor", scoped: "none", repeatBefore: false, repeatAfter: false },
    { name: "repeated pending release", scoped: "none", repeatBefore: false, repeatAfter: true },
    { name: "scoped return", scoped: "return", repeatBefore: true, repeatAfter: false },
    { name: "scoped throw", scoped: "throw", repeatBefore: false, repeatAfter: false },
  ] as const)("preserves ownership after $name", async ({ scoped, repeatBefore, repeatAfter }) => {
    const directory = await tempRoot("fs-safe-sync-root-exit-settlement-");
    const target = path.join(directory, "state.json");
    const owner = "same-owner";
    const callbackFailure = new Error("scoped callback failed");
    let armed = false;
    let authorityCallbacks = 0;
    let scopedRuns = 0;
    let scopedResult: string | undefined;
    let observedFailure: unknown;
    let original: ReturnType<typeof acquireFileLockSync> | undefined;
    let retained: ReturnType<typeof acquireFileLockSync> | undefined;
    const lockRoot = await root(directory, {
      assertBeforeMutation: () => {
        authorityCallbacks += 1;
        if (!armed) return;
        armed = false;
        original!.release();
        if (repeatBefore) original!.release();
        if (scoped !== "none") {
          try {
            scopedResult = withFileLockSync(target, {
              lockRoot,
              payload: () => ({ owner: "scoped" }),
              reentrantOwner: owner,
            }, () => {
              scopedRuns += 1;
              if (scoped === "throw") throw callbackFailure;
              return "scoped-result";
            });
          } catch (error) {
            observedFailure = error;
          }
          if (scoped === "return") original!.release();
        }
        retained = acquireFileLockSync(target, {
          lockRoot,
          payload: () => ({ owner: "retained" }),
          reentrantOwner: owner,
        });
        if (repeatAfter) original!.release();
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
      expect(authorityCallbacks - callbackBaseline).toBe(scoped === "none" ? 2 : 3);
      expect(scopedRuns).toBe(scoped === "none" ? 0 : 1);
      expect(scopedResult).toBe(scoped === "return" ? "scoped-result" : undefined);
      expect(observedFailure).toBe(scoped === "throw" ? callbackFailure : undefined);
      expect(heldLocks.get(original.normalizedTargetPath)).toBe(held);
      expect(held).toMatchObject({
        deferredExitReleases: undefined,
        fd: undefined,
        refCount: 2,
        releaseState: "active",
        revision: initialRevision + (scoped === "none" ? 4 : 6),
      });
      expect(close.mock.calls.length - open.mock.calls.length).toBe(1);
      expect(fs.existsSync(original.lockPath)).toBe(true);
      const ioCallsBeforeOriginalRetry = open.mock.calls.length;
      original.release();
      const revisionAfterOriginal = held.revision;
      expect(held.refCount).toBe(1);
      expect(heldLocks.get(original.normalizedTargetPath)).toBe(held);
      expect(fs.existsSync(original.lockPath)).toBe(true);
      expect(open).toHaveBeenCalledTimes(ioCallsBeforeOriginalRetry);
      if (scoped === "return") {
        original.release();
        expect(held.refCount).toBe(1);
        expect(held.revision).toBe(revisionAfterOriginal);
      }
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

  itPosix("denies the exact canonical reclaim path for a followed sidecar alias", async () => {
    const directory = await tempRoot("fs-safe-sync-root-canonical-reclaim-deny-");
    const target = path.join(directory, "state.json");
    const canonicalLockPath = path.join(directory, "canonical.lock");
    const aliasLockPath = path.join(directory, "alias.lock");
    const canonicalReclaimPath = `${canonicalLockPath}.reclaim`;
    fs.writeFileSync(canonicalLockPath, "{}");
    fs.symlinkSync(path.basename(canonicalLockPath), aliasLockPath, "file");
    const payload = vi.fn(() => ({ owner: "contender" }));
    const shouldReclaim = vi.fn(() => true);
    const lockRoot = await root(directory, {
      denyMutations: { paths: [canonicalReclaimPath] },
      symlinks: "follow-within-root",
    });
    expect(() => acquireFileLockSync(target, {
      ...immediate,
      lockPath: aliasLockPath,
      lockRoot,
      payload,
      shouldReclaim,
    })).toThrow(expect.objectContaining({ code: "denied-path" }));
    expect(payload).not.toHaveBeenCalled();
    expect(shouldReclaim).not.toHaveBeenCalled();
    expect(fs.readFileSync(canonicalLockPath, "utf8")).toBe("{}");
    expect(fs.lstatSync(aliasLockPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(canonicalReclaimPath)).toBe(false);
    expect(fs.existsSync(`${aliasLockPath}.reclaim`)).toBe(false);
  });
});
