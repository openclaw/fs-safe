import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync, createFileLockManager, withFileLockSync } from "../src/file-lock.js";
import { getSyncHeldLocks } from "../src/file-lock-sync-admission.js";
import { root } from "../src/root.js";
import {
  readSidecarLockRawSnapshotSync,
  serializeSidecarLockPayload,
} from "../src/sidecar-lock-reclaim.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const immediate = { timeoutMs: 0, retry: { retries: 0 }, payload: () => ({ owner: "candidate" }) };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("lock observation and callback ownership", () => {
  it("does not promote a token read from disk into creator authority", async () => {
    const directory = await tempRoot("fs-safe-observed-lock-token-");
    const lockPath = path.join(directory, "state.lock");
    const serialized = serializeSidecarLockPayload({ owner: "foreign" });
    fs.writeFileSync(lockPath, serialized.raw);
    const snapshot = readSidecarLockRawSnapshotSync(lockPath);
    expect(snapshot?.raw).toBe(serialized.raw);
    expect(snapshot).not.toHaveProperty("ownershipToken");
  });

  it("preserves a same-bytes replacement of an observed stale lock", async () => {
    const directory = await tempRoot("fs-safe-observed-lock-replaced-");
    const target = path.join(directory, "state.json");
    const lockPath = `${target}.lock`;
    const saved = `${lockPath}.saved`;
    const serialized = serializeSidecarLockPayload({ owner: "foreign" });
    fs.writeFileSync(lockPath, serialized.raw);
    const original = fs.statSync(lockPath, { bigint: true });
    let replacement: BigIntStats | undefined;
    let acquired: ReturnType<typeof acquireFileLockSync> | undefined;
    try {
      expect(() => {
        acquired = acquireFileLockSync(target, {
          ...immediate,
          staleRecovery: "remove-if-unchanged",
          shouldReclaim: () => true,
          shouldRemoveStaleLock: () => {
            fs.renameSync(lockPath, saved);
            fs.writeFileSync(lockPath, serialized.raw);
            replacement = fs.statSync(lockPath, { bigint: true });
            return true;
          },
        });
      }).toThrow(expect.objectContaining({ code: "file_lock_stale" }));
      expect(replacement?.ino).not.toBe(original.ino);
      expect(fs.statSync(lockPath, { bigint: true }).ino).toBe(replacement?.ino);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(serialized.raw);
      expect(fs.readFileSync(saved, "utf8")).toBe(serialized.raw);
      expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
    } finally {
      acquired?.release();
    }
  });

  for (const route of ["raw", "root"] as const) {
    for (const policy of ["shouldReclaim", "shouldRemoveStaleLock"] as const) {
      it.each([false, true])(`rejects a Promise from ${route} ${policy} instead of approving %s`, async (decision) => {
        const directory = await tempRoot("fs-safe-sync-lock-promise-policy-");
        const target = path.join(directory, "state.json");
        const lockPath = `${target}.lock`;
        const raw = JSON.stringify({ owner: "foreign" });
        fs.writeFileSync(lockPath, raw);
        const before = fs.statSync(lockPath, { bigint: true });
        const lockRoot = route === "root" ? await root(directory) : undefined;
        let acquired: ReturnType<typeof acquireFileLockSync> | undefined;
        try {
          expect(() => {
            acquired = acquireFileLockSync(target, {
              ...immediate,
              lockRoot,
              staleRecovery: "remove-if-unchanged",
              shouldReclaim: () => true,
              shouldRemoveStaleLock: () => true,
              [policy]: () => Promise.resolve(decision),
            } as unknown as Parameters<typeof acquireFileLockSync>[1]);
          }).toThrow(`${policy} must be synchronous`);
          expect(fs.statSync(lockPath, { bigint: true }).ino).toBe(before.ino);
          expect(fs.readFileSync(lockPath, "utf8")).toBe(raw);
          expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
        } finally {
          acquired?.release();
        }
      });

      it.each(["thenable", "rejection", "throwing getter"] as const)(
        `rejects ${route} ${policy} %s before deleting the sidecar`,
        async (kind) => {
          const directory = await tempRoot("fs-safe-sync-lock-thenable-policy-");
          const target = path.join(directory, "state.json");
          const lockPath = `${target}.lock`;
          fs.writeFileSync(lockPath, "{}");
          const before = fs.statSync(lockPath, { bigint: true });
          const lockRoot = route === "root" ? await root(directory) : undefined;
          const failure = new Error("policy result inspection failed");
          const callback = vi.fn(function (this: unknown) {
            if (kind === "rejection") return Promise.reject(failure);
            return Object.defineProperty({}, "then", {
              get() {
                if (kind === "throwing getter") throw failure;
                return (resolve: (value: boolean) => void) => resolve(false);
              },
            });
          });
          const options = {
            ...immediate, lockRoot,
            staleRecovery: "remove-if-unchanged",
            shouldReclaim: () => true,
            shouldRemoveStaleLock: () => true,
            [policy]: callback,
          } as unknown as Parameters<typeof acquireFileLockSync>[1];
          expect(() => acquireFileLockSync(target, options))
            .toThrow(kind === "throwing getter" ? failure : `${policy} must be synchronous`);
          await Promise.resolve();
          expect(callback).toHaveBeenCalledTimes(1);
          expect(callback.mock.contexts[0]).toBe(options);
          expect(fs.statSync(lockPath, { bigint: true }).ino).toBe(before.ino);
          expect(fs.readFileSync(lockPath, "utf8")).toBe("{}");
          expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
        },
      );
    }
  }

  it.each([new Error("callback failed"), undefined, null, false, 0])(
    "preserves raw scoped callback failure %s when release also fails",
    async (callbackError) => {
      const directory = await tempRoot("fs-safe-sync-lock-dual-failure-");
      const target = path.join(directory, "state.json");
      const lockPath = `${target}.lock`;
      const releaseError = Object.assign(new Error("remove failed"), { code: "EACCES" });
      const remove = fs.rmSync.bind(fs);
      vi.spyOn(fs, "rmSync").mockImplementation((entry, options) => {
        if (String(entry) === lockPath) throw releaseError;
        return remove(entry, options);
      });
      let failure: unknown;
      try {
        try {
          withFileLockSync(target, immediate, () => { throw callbackError; });
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ name: "SuppressedError", error: releaseError });
        expect(failure).toHaveProperty("suppressed", callbackError);
      } finally {
        vi.restoreAllMocks();
        const held = getSyncHeldLocks().get(target);
        if (held?.fd !== undefined) fs.closeSync(held.fd);
        getSyncHeldLocks().delete(target);
      }
    },
  );
});

describe("resetting monitored lock managers", () => {
  for (const route of ["raw", "root"] as const) {
    it(`stops ${route} compromise probes after reset`, async () => {
      const directory = await tempRoot("fs-safe-lock-reset-monitor-");
      const lockRoot = route === "root" ? await root(directory) : undefined;
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const manager = createFileLockManager(directory);
      const compromised = vi.fn();
      const lock = await manager.acquire(path.join(directory, "state.json"), {
        payload: async () => ({}), lockRoot,
        compromiseCheckIntervalMs: 10, onCompromised: compromised,
      });
      const verify = vi.spyOn(lock, "verifyStillHeld");
      try {
        expect(vi.getTimerCount()).toBe(1);
        manager.reset();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(100);
        expect(verify).not.toHaveBeenCalled();
        expect(compromised).not.toHaveBeenCalled();
        expect(manager.heldEntries()).toEqual([]);
      } finally {
        manager.reset();
        await lock.release();
      }
    });

    it(`ignores an in-flight ${route} compromise result after reset`, async () => {
      const directory = await tempRoot("fs-safe-lock-reset-in-flight-");
      const lockRoot = route === "root" ? await root(directory) : undefined;
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const manager = createFileLockManager(directory);
      const compromised = vi.fn();
      const lock = await manager.acquire(path.join(directory, "state.json"), {
        payload: async () => ({}), lockRoot,
        compromiseCheckIntervalMs: 10, onCompromised: compromised,
      });
      let finish!: (held: boolean) => void;
      const pending = new Promise<boolean>((resolve) => { finish = resolve; });
      const verify = vi.spyOn(lock, "verifyStillHeld").mockReturnValue(pending);
      try {
        await vi.advanceTimersByTimeAsync(10);
        expect(verify).toHaveBeenCalledTimes(1);
        manager.reset();
        finish(false);
        await vi.advanceTimersByTimeAsync(100);
        expect(compromised).not.toHaveBeenCalled();
        expect(verify).toHaveBeenCalledTimes(1);
      } finally {
        finish(false);
        manager.reset();
        await lock.release();
      }
    });
  }
});
