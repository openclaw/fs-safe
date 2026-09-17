import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFileLockSync,
  type FileLockSyncAcquireOptions,
  type FileLockSyncHandle,
} from "../src/file-lock.js";
import * as timing from "../src/timing.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const heldKey = Symbol.for("fsSafe.syncSidecarLocks");
const admissionsKey = Symbol.for("fsSafe.syncSidecarLockAdmissions");
const cleanupHandlerKey = Symbol.for("fsSafe.syncSidecarLockCleanupHandler");

function heldLocks(): Map<string, unknown> {
  return Reflect.get(globalThis, heldKey) as Map<string, unknown>;
}

function admissions(): Map<string, object> {
  return Reflect.get(globalThis, admissionsKey) as Map<string, object>;
}

afterEach(() => {
  vi.restoreAllMocks();
  (Reflect.get(globalThis, cleanupHandlerKey) as (() => void) | undefined)?.();
  (Reflect.get(globalThis, heldKey) as Map<string, unknown> | undefined)?.clear();
  (Reflect.get(globalThis, admissionsKey) as Map<string, object> | undefined)?.clear();
});

describe("synchronous sidecar retry compatibility", () => {
  it.each(["default", "alternate"] as const)(
    "runs one historical payload/serialization attempt against a %s retained holder",
    async (sidecar) => {
      const directory = await tempRoot(`fs-safe-sync-held-${sidecar}-`);
      const target = path.join(directory, "state.json");
      const alternatePath = path.join(directory, "alternate.lock");
      const holder = acquireFileLockSync(target, { payload: () => ({ owner: "holder" }) });
      const original = fsSync.readFileSync(holder.lockPath, "utf8");
      const open = vi.spyOn(fsSync, "openSync");
      const toJSON = vi.fn(() => ({ owner: "candidate" }));
      const payload = vi.fn(() => ({ toJSON }));
      const staleCallback = vi.fn(() => false);
      let staleRecoveryReads = 0;
      let staleAccessorReads = 0;
      let heldAccessorReads = 0;
      const options: FileLockSyncAcquireOptions<Record<string, unknown>> = {
        payload,
        timeoutMs: 0,
        retry: { retries: 0 },
        ...(sidecar === "alternate" ? { lockPath: alternatePath } : {}),
        get staleRecovery() {
          staleRecoveryReads += 1;
          return "fail-closed";
        },
        get shouldReclaim() {
          staleAccessorReads += 1;
          return staleCallback;
        },
        get shouldRemoveStaleLock() {
          staleAccessorReads += 1;
          return staleCallback;
        },
        get onCompromised() {
          heldAccessorReads += 1;
          return undefined;
        },
        get parsePayload() {
          heldAccessorReads += 1;
          return undefined;
        },
      };
      try {
        expect(() => acquireFileLockSync(target, options)).toThrow(expect.objectContaining({
          code: "file_lock_timeout",
          lockPath: sidecar === "alternate" ? alternatePath : holder.lockPath,
        }));
        expect(payload).toHaveBeenCalledOnce();
        expect(toJSON).toHaveBeenCalledOnce();
        expect(staleRecoveryReads).toBe(1);
        expect(staleAccessorReads).toBe(0);
        expect(heldAccessorReads).toBe(0);
        expect(staleCallback).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(fsSync.readFileSync(holder.lockPath, "utf8")).toBe(original);
        expect(fsSync.existsSync(alternatePath)).toBe(false);
        expect(holder.verifyStillHeld()).toBe(true);
        expect(admissions().size).toBe(0);
      } finally {
        holder.release();
      }
    },
  );

  it.each(["payload", "serialization"] as const)(
    "acquires without retry when the retained holder releases during %s",
    async (stage) => {
      const directory = await tempRoot(`fs-safe-sync-release-${stage}-`);
      const target = path.join(directory, "state.json");
      const alternatePath = path.join(directory, "replacement.lock");
      const holder = acquireFileLockSync(target, { payload: () => ({ owner: "holder" }) });
      const sleep = vi.spyOn(timing, "sleepSync");
      const toJSON = vi.fn(() => {
        if (stage === "serialization") holder.release();
        return { owner: "replacement" };
      });
      const payload = vi.fn(() => {
        if (stage === "payload") holder.release();
        return { toJSON };
      });
      let replacement: FileLockSyncHandle | undefined;
      try {
        replacement = acquireFileLockSync(target, {
          lockPath: alternatePath,
          payload,
          timeoutMs: 0,
          retry: { retries: 0 },
        });
        expect(replacement.lockPath).toBe(alternatePath);
        expect(payload).toHaveBeenCalledOnce();
        expect(toJSON).toHaveBeenCalledOnce();
        expect(sleep).not.toHaveBeenCalled();
        expect(fsSync.existsSync(holder.lockPath)).toBe(false);
        expect(JSON.parse(fsSync.readFileSync(alternatePath, "utf8"))).toEqual({
          owner: "replacement",
        });
        expect(admissions().size).toBe(0);
      } finally {
        replacement?.release();
        holder.release();
      }
    },
  );

  it("lets release enable the outer attempt while nested replacement fails before payload", async () => {
    const directory = await tempRoot("fs-safe-sync-release-nested-");
    const target = path.join(directory, "state.json");
    const outerPath = path.join(directory, "outer.lock");
    const nestedPath = path.join(directory, "nested.lock");
    const differentTarget = path.join(directory, "different.json");
    const holder = acquireFileLockSync(target, { payload: () => ({ owner: "holder" }) });
    const nestedPayload = vi.fn(() => ({ owner: "nested" }));
    const differentPayload = vi.fn(() => ({ owner: "different" }));
    let nestedError: unknown;
    const payload = vi.fn(() => {
      holder.release();
      try {
        acquireFileLockSync(target, {
          lockPath: nestedPath,
          payload: nestedPayload,
          timeoutMs: Number.POSITIVE_INFINITY,
          retry: {},
        });
      } catch (error) {
        nestedError = error;
      }
      const different = acquireFileLockSync(differentTarget, { payload: differentPayload });
      different.release();
      return { owner: "outer" };
    });
    const sleep = vi.spyOn(timing, "sleepSync");
    let outer: FileLockSyncHandle | undefined;
    try {
      outer = acquireFileLockSync(target, {
        lockPath: outerPath,
        payload,
        timeoutMs: 0,
        retry: { retries: 0 },
      });
      expect(nestedError).toMatchObject({ code: "file_lock_timeout", lockPath: nestedPath });
      expect(nestedPayload).not.toHaveBeenCalled();
      expect(differentPayload).toHaveBeenCalledOnce();
      expect(payload).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
      expect(fsSync.existsSync(nestedPath)).toBe(false);
      expect(fsSync.existsSync(`${differentTarget}.lock`)).toBe(false);
      expect(outer.verifyStillHeld()).toBe(true);
    } finally {
      outer?.release();
      holder.release();
    }
  });

  it("fails unbounded nested foreign reentry before payload while the holder remains", async () => {
    const directory = await tempRoot("fs-safe-sync-held-nested-");
    const target = path.join(directory, "state.json");
    const outerPath = path.join(directory, "outer.lock");
    const nestedPath = path.join(directory, "nested.lock");
    const holder = acquireFileLockSync(target, {
      payload: () => ({ owner: "holder" }),
      reentrantOwner: "holder",
    });
    const nestedPayload = vi.fn(() => ({ owner: "nested" }));
    let nestedError: unknown;
    const outerPayload = vi.fn(() => {
      try {
        acquireFileLockSync(target, {
          lockPath: nestedPath,
          payload: nestedPayload,
          reentrantOwner: "nested",
          timeoutMs: Number.POSITIVE_INFINITY,
          retry: {},
        });
      } catch (error) {
        nestedError = error;
      }
      return { owner: "outer" };
    });
    try {
      expect(() => acquireFileLockSync(target, {
        lockPath: outerPath,
        payload: outerPayload,
        reentrantOwner: "outer",
        timeoutMs: 0,
        retry: { retries: 0 },
      })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
      expect(outerPayload).toHaveBeenCalledOnce();
      expect(nestedPayload).not.toHaveBeenCalled();
      expect(nestedError).toMatchObject({ code: "file_lock_timeout", lockPath: nestedPath });
      expect(holder.verifyStillHeld()).toBe(true);
      expect(fsSync.existsSync(outerPath)).toBe(false);
      expect(fsSync.existsSync(nestedPath)).toBe(false);
    } finally {
      holder.release();
    }
  });

  it.each(["staleRecovery", "payload", "serialization"] as const)(
    "preserves the holder and exact %s failure",
    async (stage) => {
      const directory = await tempRoot(`fs-safe-sync-held-failure-${stage}-`);
      const target = path.join(directory, "state.json");
      const alternatePath = path.join(directory, "alternate.lock");
      const holder = acquireFileLockSync(target, { payload: () => ({ owner: "holder" }) });
      const original = fsSync.readFileSync(holder.lockPath, "utf8");
      const failure = new Error(`${stage} failed`);
      const payload = vi.fn(() => {
        if (stage === "payload") throw failure;
        return { toJSON: () => {
          if (stage === "serialization") throw failure;
          return { owner: "candidate" };
        } };
      });
      const options: FileLockSyncAcquireOptions<Record<string, unknown>> = {
        lockPath: alternatePath,
        payload,
        get staleRecovery() {
          if (stage === "staleRecovery") throw failure;
          return "fail-closed";
        },
      };
      try {
        expect(() => acquireFileLockSync(target, options)).toThrow(failure);
        expect(payload).toHaveBeenCalledTimes(stage === "staleRecovery" ? 0 : 1);
        expect(fsSync.readFileSync(holder.lockPath, "utf8")).toBe(original);
        expect(fsSync.existsSync(alternatePath)).toBe(false);
        expect(holder.verifyStillHeld()).toBe(true);
        expect(admissions().size).toBe(0);
      } finally {
        holder.release();
      }
    },
  );

  it("checks a reclaim guard before payload and charges only its retry", async () => {
    const directory = await tempRoot("fs-safe-sync-held-guard-");
    const target = path.join(directory, "state.json");
    const alternatePath = path.join(directory, "alternate.lock");
    const reclaimGuardPath = `${alternatePath}.reclaim`;
    const holder = acquireFileLockSync(target, { payload: () => ({ owner: "holder" }) });
    fsSync.mkdirSync(reclaimGuardPath);
    const payload = vi.fn(() => ({ owner: "candidate" }));
    const waits: number[] = [];
    vi.spyOn(timing, "sleepSync").mockImplementation((ms) => {
      waits.push(ms);
      expect(payload).not.toHaveBeenCalled();
      fsSync.rmdirSync(reclaimGuardPath);
      holder.release();
    });
    let replacement: FileLockSyncHandle | undefined;
    try {
      replacement = acquireFileLockSync(target, {
        lockPath: alternatePath,
        payload,
        timeoutMs: Number.POSITIVE_INFINITY,
        retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
      });
      expect(waits).toEqual([0]);
      expect(payload).toHaveBeenCalledOnce();
      expect(replacement.verifyStillHeld()).toBe(true);
    } finally {
      replacement?.release();
      holder.release();
      fsSync.rmSync(reclaimGuardPath, { recursive: true, force: true });
    }
  });

  it("rechecks held ownership after delayed getters and the late timer hook", async () => {
    const directory = await tempRoot("fs-safe-sync-delayed-holder-");
    const target = path.join(directory, "state.json");
    const normalizedTarget = path.join(
      process.platform === "win32"
        ? fsSync.realpathSync.native(directory)
        : fsSync.realpathSync(directory),
      path.basename(target),
    );
    const getterPath = path.join(directory, "getter.lock");
    const latePath = path.join(directory, "late.lock");
    const foreignFromGetter = { owner: "getter" };
    const foreignFromTimer = { owner: "timer" };
    expect(() => acquireFileLockSync(target, {
      lockPath: getterPath,
      payload: () => ({ owner: "candidate" }),
      timeoutMs: 0,
      retry: { retries: 0 },
      get onCompromised() {
        heldLocks().set(normalizedTarget, foreignFromGetter);
        return undefined;
      },
    })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    expect(heldLocks().get(normalizedTarget)).toBe(foreignFromGetter);
    expect(fsSync.existsSync(getterPath)).toBe(false);
    expect(admissions().size).toBe(0);
    heldLocks().clear();

    const timer = {
      unref() {
        heldLocks().set(normalizedTarget, foreignFromTimer);
      },
    } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockReturnValueOnce(timer);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    expect(() => acquireFileLockSync(target, {
      lockPath: latePath,
      payload: () => ({ owner: "candidate" }),
      timeoutMs: 0,
      retry: { retries: 0 },
      compromiseCheckIntervalMs: 1,
      onCompromised: () => undefined,
    })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    expect(heldLocks().get(normalizedTarget)).toBe(foreignFromTimer);
    expect(fsSync.existsSync(latePath)).toBe(false);
    expect(admissions().size).toBe(0);
    heldLocks().clear();
  });
});
