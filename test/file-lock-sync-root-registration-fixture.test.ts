import { describe, expect, it, vi } from "vitest";
import {
  countExactExitListener,
  isolateRootSyncRegistration,
  originalProcessOn,
  originalProcessRemoveListener,
  removeExactExitListeners,
  ROOT_SYNC_CLEANUP_HANDLER_KEY,
  ROOT_SYNC_CLEANUP_REGISTERED_KEY,
  runWithCleanups,
} from "./helpers/root-sync-registration-fixture.js";

describe("bounded Root registration fixture cleanup", () => {
  it("handles zero, one, and duplicate exact listeners without touching unrelated listeners", async () => {
    const exact = () => {};
    const unrelated = () => {};
    await runWithCleanups(() => {
      originalProcessOn("exit", exact);
      originalProcessOn("exit", unrelated);
      originalProcessOn("exit", exact);
      removeExactExitListeners(exact, "bounded-helper-test");
      expect(countExactExitListener(exact)).toBe(0);
      expect(countExactExitListener(unrelated)).toBe(1);
      removeExactExitListeners(exact, "bounded-helper-empty-test");
      expect(countExactExitListener(unrelated)).toBe(1);
    }, [
      () => { originalProcessRemoveListener("exit", exact); },
      () => { originalProcessRemoveListener("exit", exact); },
      () => { originalProcessRemoveListener("exit", unrelated); },
    ]);
  });

  it("fails immediately when removal is a no-op", () => {
    const listener = () => {};
    expect(() => removeExactExitListeners(listener, "no-op-test", {
      count: () => 1,
      remove: () => {},
    })).toThrow(/no exit-listener cleanup progress.*before=1, after=1/u);
  });

  it("fails immediately when removal is followed by listener re-addition", () => {
    const listener = () => {};
    let remaining = 1;
    expect(() => removeExactExitListeners(listener, "re-addition-test", {
      count: () => remaining,
      remove: () => {
        remaining -= 1;
        remaining += 1;
      },
    })).toThrow(/no exit-listener cleanup progress.*before=1, after=1/u);
    expect(remaining).toBe(1);
  });

  it("preserves removal errors before and after a count change", () => {
    const listener = () => {};
    const beforeFailure = new Error("removal failed before mutation");
    expect(() => removeExactExitListeners(listener, "pre-mutation-test", {
      count: () => 1,
      remove: () => { throw beforeFailure; },
    })).toThrow(expect.objectContaining({
      name: "SuppressedError",
      error: beforeFailure,
      suppressed: expect.objectContaining({ message: expect.stringContaining("before=1, after=1") }),
    }));

    const afterFailure = new Error("removal failed after mutation");
    let remaining = 1;
    expect(() => removeExactExitListeners(listener, "post-mutation-test", {
      count: () => remaining,
      remove: () => {
        remaining = 0;
        throw afterFailure;
      },
    })).toThrow(afterFailure);
    expect(remaining).toBe(0);
  });

  it("preserves a body failure, cleanup failure, and later cleanup", async () => {
    const bodyFailure = new Error("fixture assertion failed");
    const cleanupFailure = new Error("fixture cleanup failed");
    const laterCleanup = vi.fn();
    await expect(runWithCleanups(
      () => { throw bodyFailure; },
      [() => { throw cleanupFailure; }, laterCleanup],
    )).rejects.toMatchObject({
      name: "SuppressedError",
      error: cleanupFailure,
      suppressed: bodyFailure,
    });
    expect(laterCleanup).toHaveBeenCalledOnce();
  });

  it("preserves undefined thrown values", async () => {
    let rejected = false;
    let rejection: unknown = "not rejected";
    try {
      await runWithCleanups(() => undefined, [() => { throw undefined; }]);
    } catch (error) {
      rejected = true;
      rejection = error;
    }
    expect(rejected).toBe(true);
    expect(rejection).toBeUndefined();
    expect(() => removeExactExitListeners(() => {}, "undefined-removal-test", {
      count: () => 1,
      remove: () => { throw undefined; },
    })).toThrow(expect.objectContaining({ name: "SuppressedError", error: undefined }));
  });

  it("transactionally restores a saved listener after partial isolation failure", async () => {
    const restoreOuterState = isolateRootSyncRegistration();
    const savedHandler = () => {};
    const removalFailure = new Error("removeListener observer rejected after removal");
    await runWithCleanups(() => {
      Reflect.set(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY, savedHandler);
      Reflect.set(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY, true);
      originalProcessOn("exit", savedHandler);
      expect(() => isolateRootSyncRegistration({
        count: countExactExitListener,
        remove: (listener) => {
          originalProcessRemoveListener("exit", listener);
          throw removalFailure;
        },
      })).toThrow(removalFailure);
      expect(countExactExitListener(savedHandler)).toBe(1);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_HANDLER_KEY)).toBe(savedHandler);
      expect(Reflect.get(globalThis, ROOT_SYNC_CLEANUP_REGISTERED_KEY)).toBe(true);
    }, [
      () => removeExactExitListeners(savedHandler, "transactional-helper-test cleanup"),
      restoreOuterState,
    ]);
  });
});
