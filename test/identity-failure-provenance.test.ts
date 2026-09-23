import fsSync from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { fileObservation, isFileObservationFailure } from "../src/file-observation.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import type { NativeBinding } from "../src/native-binding.js";
import { inspectSecureWindowsFile } from "../src/secure-file-windows.js";
import { admitTempWorkspaceRootSync } from "../src/temp-workspace-admission.js";
import { inspectTempWorkspaceDirectoryIdentitySync } from "../src/temp-workspace-child-admission.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const expected = { dev: 101n, ino: 202n };
const numeric = { dev: 101, ino: 202 };
const owners = ["root", "child", "windows-type", "windows-format", "windows-mismatch"] as const;

beforeEach(() => configureFsSafeNative({ mode: "require" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

async function captureFailure(operation: () => unknown): Promise<unknown> {
  try { await operation(); } catch (error) { return error; }
  throw new Error("expected identity admission to fail");
}

async function failingAdmission(owner: typeof owners[number]) {
  const dir = await tempRoot("fs-safe-identity-provenance-");
  let upstream: FsSafeError | undefined;
  if (owner === "root" || owner === "child") {
    const lstat = fsSync.lstatSync.bind(fsSync);
    let changed = owner === "child";
    vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
      const stat = lstat(name, options);
      if (name !== dir || !stat) return stat;
      if (upstream) throw upstream;
      Object.assign(stat, typeof stat.dev === "bigint"
        ? { dev: expected.dev, ino: expected.ino + (changed ? 1n : 0n) }
        : { dev: numeric.dev, ino: numeric.ino + (changed ? 1 : 0) });
      return stat;
    });
    const admission = owner === "root" ? admitTempWorkspaceRootSync(dir) : undefined;
    return (failure?: FsSafeError) => {
      upstream = failure;
      changed = true;
      return admission
        ? admission.prepareChildCreation()
        : inspectTempWorkspaceDirectoryIdentitySync(dir, expected, numeric);
    };
  }

  const stat = fsSync.statSync(dir);
  const identity = owner === "windows-type" ? 42
    : owner === "windows-format" ? "not-an-identity" : "00000065:00000000000000cb";
  __setNativeLoaderForTest(() => ({
    closeOwnedFd: vi.fn(),
    inspectWindowsSecureFileHandle: () => ({
      get identity() {
        if (upstream) throw upstream;
        return identity;
      },
      get security() { throw new Error("ACL facts must not be read after identity rejection"); },
    }),
  }) as unknown as NativeBinding);
  return (failure?: FsSafeError) => {
    upstream = failure;
    return inspectSecureWindowsFile({ fd: 73, identity: expected, stat });
  };
}

it.each(owners)("keeps %s identity failures in their originating observation", async (owner) => {
  const reject = await failingAdmission(owner);
  const outer = fileObservation(), inner = fileObservation(), later = fileObservation();
  const supplied = new FsSafeError("path-mismatch", "file identity changed or could not be verified");
  const failures: unknown[] = [];
  await outer.run(async () => {
    failures.push(await captureFailure(() => reject()));
    await inner.run(async () => {
      await Promise.resolve();
      failures.push(await captureFailure(() => reject()));
      expect(isFileObservationFailure(failures[0], "identity")).toBe(false);
      expect(isFileObservationFailure(failures[1], "identity")).toBe(true);
      expect(await captureFailure(() => reject(supplied))).toBe(supplied);
      expect(isFileObservationFailure(supplied, "identity")).toBe(false);
    });
    expect(isFileObservationFailure(failures[0], "identity")).toBe(true);
    expect(isFileObservationFailure(failures[1], "identity")).toBe(false);
    failures.push(await captureFailure(() => reject()));
  });
  expect(new Set(failures).size).toBe(3);
  for (const [index, failure] of failures.entries()) {
    expect(failure).toBeInstanceOf(FsSafeError);
    expect(failure).toMatchObject({
      code: "path-mismatch",
      category: "policy",
      message: "file identity changed or could not be verified",
    });
    expect(outer.has(failure, "identity")).toBe(index !== 1);
    expect(inner.has(failure, "identity")).toBe(index === 1);
    expect(later.has(failure, "identity")).toBe(false);
    expect(isFileObservationFailure(failure, "identity")).toBe(false);
  }
  expect(outer.has(supplied, "identity")).toBe(false);
  expect(inner.has(supplied, "identity")).toBe(false);
});
