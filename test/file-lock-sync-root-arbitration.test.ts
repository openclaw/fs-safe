import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mutation = vi.hoisted(() => ({
  removeFileLockSyncRootFile: vi.fn(),
}));

vi.mock("../src/file-lock-sync-root-mutation.js", () => ({
  removeFileLockSyncRootFile: mutation.removeFileLockSyncRootFile,
}));

import { cleanupCreatedRootSyncLock } from "../src/file-lock-sync-root-arbitration.js";

const lockRootPath = Object.freeze({}) as never;
const receipt = Object.freeze({}) as never;
const timer = Object.freeze({}) as unknown as NodeJS.Timeout;

afterEach(() => {
  mutation.removeFileLockSyncRootFile.mockReset();
  vi.restoreAllMocks();
});

function captureThrown(operation: () => void): { error: unknown; threw: boolean } {
  let error: unknown;
  let threw = false;
  try {
    operation();
  } catch (caught) {
    error = caught;
    threw = true;
  }
  return { error, threw };
}

describe("synchronous Root unpublished-lock cleanup", () => {
  it.each([
    ["an Error", new Error("timer cleanup failed")],
    ["undefined", undefined],
  ] as const)("finishes file cleanup and preserves a timer throwing %s", (
    _failureKind,
    timerCleanupFailure,
  ) => {
    const close = vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
    const clear = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {
      throw timerCleanupFailure;
    });
    mutation.removeFileLockSyncRootFile.mockReturnValue(true);

    const thrown = captureThrown(() => {
      cleanupCreatedRootSyncLock(lockRootPath, 41, receipt, timer);
    });

    expect(thrown.threw).toBe(true);
    expect(thrown.error).toBe(timerCleanupFailure);
    expect(clear).toHaveBeenCalledExactlyOnceWith(timer);
    expect(close).toHaveBeenCalledExactlyOnceWith(41);
    expect(mutation.removeFileLockSyncRootFile)
      .toHaveBeenCalledExactlyOnceWith(lockRootPath, receipt);
  });

  it.each([
    ["an Error", new Error("timer cleanup failed")],
    ["undefined", undefined],
  ] as const)("preserves paired file cleanup failure after a timer throws %s", (
    _failureKind,
    timerCleanupFailure,
  ) => {
    const fileCleanupFailure = new Error("file cleanup failed");
    const close = vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
    const clear = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {
      throw timerCleanupFailure;
    });
    mutation.removeFileLockSyncRootFile.mockImplementation(() => {
      throw fileCleanupFailure;
    });

    const thrown = captureThrown(() => {
      cleanupCreatedRootSyncLock(lockRootPath, 42, receipt, timer);
    });

    expect(thrown.threw).toBe(true);
    expect(thrown.error).toMatchObject({ name: "SuppressedError" });
    expect(Object.hasOwn(thrown.error as object, "error")).toBe(true);
    expect((thrown.error as { error: unknown }).error).toBe(timerCleanupFailure);
    expect(Object.hasOwn(thrown.error as object, "suppressed")).toBe(true);
    expect((thrown.error as { suppressed: unknown }).suppressed).toBe(fileCleanupFailure);
    expect(clear).toHaveBeenCalledExactlyOnceWith(timer);
    expect(close).toHaveBeenCalledExactlyOnceWith(42);
    expect(mutation.removeFileLockSyncRootFile)
      .toHaveBeenCalledExactlyOnceWith(lockRootPath, receipt);
  });
});
