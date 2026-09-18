import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { createSidecarLockManager, type SidecarLockHandle } from "../src/sidecar-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => { throw new Error("expected acquisition to reject"); },
    (error: unknown) => error,
  );
}

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  vi.restoreAllMocks();
});

describe("async sidecar admission scope lifecycle", () => {
  it("keeps active ancestors behind an inactive child scope without retaining the child", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-inactive-child-");
    const targetA = path.join(directory, "a.json");
    const targetB = path.join(directory, "b.json");
    const targetC = path.join(directory, "c.json");
    const key = `inactive-child:${directory}`;
    const manager = createSidecarLockManager(key);
    const sameDomainWrapper = createSidecarLockManager(key);
    const otherDomain = createSidecarLockManager(`inactive-child-other:${directory}`);
    vi.resetModules();
    const secondGraph = await import("../src/sidecar-lock.js");
    const copiedDomainWrapper = secondGraph.createSidecarLockManager(key);
    const startWhileAActive = deferred();
    const whileAActiveDone = deferred();
    const startAfterARelease = deferred();
    const rejectedPayload = vi.fn(async () => ({ owner: "rejected-a" }));
    const allowedPayload = vi.fn(async () => ({ owner: "allowed" }));
    let descendantError: unknown;
    let detached: Promise<void> | undefined;
    let afterRelease: SidecarLockHandle | undefined;
    let outer: SidecarLockHandle | undefined;
    try {
      const acquiringA = manager.acquire({
        targetPath: targetA,
        lockPath: path.join(directory, "outer-a.lock"),
        staleMs: 30_000,
        payload: async () => {
          const middle = await manager.acquire({
            targetPath: targetB,
            staleMs: 30_000,
            payload: async () => {
              detached = (async () => {
                await startWhileAActive.promise;
                descendantError = await rejection(copiedDomainWrapper.acquire({
                  targetPath: targetA,
                  lockPath: path.join(directory, "rejected-a.lock"),
                  staleMs: 30_000,
                  timeoutMs: Number.POSITIVE_INFINITY,
                  retry: {},
                  payload: rejectedPayload,
                }));
                const reacquiredB = await sameDomainWrapper.acquire({
                  targetPath: targetB,
                  staleMs: 30_000,
                  payload: allowedPayload,
                });
                await reacquiredB.release();
                const acquiredC = await sameDomainWrapper.acquire({
                  targetPath: targetC,
                  staleMs: 30_000,
                  payload: allowedPayload,
                });
                await acquiredC.release();
                const crossDomainA = await otherDomain.acquire({
                  targetPath: targetA,
                  lockPath: path.join(directory, "other-domain-a.lock"),
                  staleMs: 30_000,
                  payload: allowedPayload,
                });
                await crossDomainA.release();
                whileAActiveDone.resolve();
                await startAfterARelease.promise;
                afterRelease = await copiedDomainWrapper.acquire({
                  targetPath: targetA,
                  staleMs: 30_000,
                  payload: allowedPayload,
                });
              })();
              return { owner: "middle-b" };
            },
          });
          await middle.release();
          startWhileAActive.resolve();
          await whileAActiveDone.promise;
          return { owner: "outer-a" };
        },
      });
      outer = await acquiringA;
      expect(descendantError).toMatchObject({ code: "file_lock_timeout" });
      expect(rejectedPayload).not.toHaveBeenCalled();
      expect(allowedPayload).toHaveBeenCalledTimes(3);
      await outer.release();
      outer = undefined;
      startAfterARelease.resolve();
      await detached;
      expect(afterRelease).toBeDefined();
      expect(await afterRelease!.verifyStillHeld()).toBe(true);
      expect(allowedPayload).toHaveBeenCalledTimes(4);
    } finally {
      startWhileAActive.resolve();
      whileAActiveDone.resolve();
      startAfterARelease.resolve();
      await detached?.catch(() => undefined);
      await afterRelease?.release().catch(() => undefined);
      await outer?.release().catch(() => undefined);
      await manager.drain();
      await copiedDomainWrapper.drain();
      await otherDomain.drain();
    }
  });
});
