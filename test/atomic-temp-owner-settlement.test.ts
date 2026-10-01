import type { BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicIo, runAsync, runSync } from "../src/atomic-io.js";
import {
  AtomicTempOwner,
  type AtomicTempFailure,
} from "../src/replace-file-temp-owner.js";
import {
  __cleanupRegisteredTempPathForTest,
  __cleanupRegisteredTempPathsForTest,
} from "../src/temp-cleanup.js";
import {
  FAILURE_VALUES, captureAsync, captureSync, consumeRetainedRegistration,
  expectReturned, thrownValue, expectNormalizedCleanup, expectCleanupWrapper,
  expectAggregate, type Captured,
} from "./helpers/atomic-settlement.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

type FailureCombination = Readonly<{
  label: string;
  operation: boolean;
  cleanup: boolean;
  close: boolean;
}>;
const FAILURE_COMBINATIONS: readonly FailureCombination[] = [
  { label: "none", operation: false, cleanup: false, close: false },
  { label: "P", operation: true, cleanup: false, close: false },
  { label: "C", operation: false, cleanup: true, close: false },
  { label: "L", operation: false, cleanup: false, close: true },
  { label: "P+C", operation: true, cleanup: true, close: false },
  { label: "P+L", operation: true, cleanup: false, close: true },
  { label: "C+L", operation: false, cleanup: true, close: true },
  { label: "P+C+L", operation: true, cleanup: true, close: true },
];

const SETTLEMENT_CASES = FAILURE_VALUES.flatMap((failure) =>
  FAILURE_COMBINATIONS.flatMap((combination) =>
    [false, true].map((reportCleanup) => ({ failure, combination, reportCleanup }))));

const OWNED_IDENTITY = {
  dev: 17n,
  ino: 23n,
  nlink: 1n,
  isFile: () => true,
  isSymbolicLink: () => false,
} as BigIntStats;

let syntheticPathIndex = 0;

afterEach(() => {
  vi.restoreAllMocks();
  __cleanupRegisteredTempPathsForTest();
});

function expectSettlement(
  outcome: Captured,
  combination: FailureCombination,
  reportCleanup: boolean,
  value: unknown,
): void {
  if (combination.cleanup && reportCleanup) {
    const assertCleanup = combination.operation
      ? (actual: unknown) => expectCleanupWrapper(actual, value, value)
      : (actual: unknown) => expectNormalizedCleanup(actual, value);
    if (combination.close) {
      expectAggregate(
        thrownValue(outcome),
        "Atomic temp cleanup and close failed",
        assertCleanup,
        value,
      );
    } else {
      assertCleanup(thrownValue(outcome));
    }
    return;
  }

  if (combination.close) {
    const actual = thrownValue(outcome);
    if (combination.operation) {
      expectAggregate(
        actual,
        "Atomic file replace and close failed",
        (first) => expect(Object.is(first, value)).toBe(true),
        value,
      );
    } else {
      expect(Object.is(actual, value)).toBe(true);
    }
    return;
  }

  // P is pending in the caller and is not rethrown by finish itself.
  expectReturned(outcome);
}

async function finishOwner(params: {
  variant: "async" | "sync";
  pathname: string;
  identity: BigIntStats;
  unlink(): void;
  close(): void;
  originalFailure?: AtomicTempFailure;
  reportCleanup: boolean;
}): Promise<Captured> {
  const { variant, pathname, identity, unlink, close, originalFailure, reportCleanup } = params;
  const io = variant === "async"
    ? AtomicIo.async({ lstat: async () => identity, unlink: async () => unlink() } as never)
    : AtomicIo.sync({ lstatSync: () => identity, unlinkSync: unlink, closeSync: close } as never);
  const owner = new AtomicTempOwner(pathname, io);
  owner.start();
  owner.adopt({
    identity,
    file: variant === "async" ? io.wrap({ close: async () => close() } as FileHandle) : io.wrap(47),
  });
  const finish = () => owner.finish({ originalFailure, throwOnCleanupError: reportCleanup });
  return variant === "async"
    ? await captureAsync(() => runAsync(finish()))
    : captureSync(() => runSync(finish()));
}

async function settleOwner(params: {
  variant: "async" | "sync";
  combination: FailureCombination;
  reportCleanup: boolean;
  value: unknown;
}): Promise<{ outcome: Captured; cleanupAttempts: number; closeAttempts: number }> {
  const pathname = path.join(
    process.cwd(),
    `.fs-safe-settlement-${process.pid}-${syntheticPathIndex++}.tmp`,
  );
  let cleanupAttempts = 0;
  let closeAttempts = 0;
  const outcome = await finishOwner({
    ...params,
    pathname,
    identity: OWNED_IDENTITY,
    originalFailure: params.combination.operation ? { error: params.value } : undefined,
    unlink() {
      cleanupAttempts += 1;
      if (params.combination.cleanup) throw params.value;
    },
    close() {
      closeAttempts += 1;
      if (params.combination.close) throw params.value;
    },
  });
  __cleanupRegisteredTempPathForTest(pathname);
  return { outcome, cleanupAttempts, closeAttempts };
}

describe.each(["async", "sync"] as const)("%s atomic temp settlement table", (variant) => {
  it.each(SETTLEMENT_CASES)(
    "$combination.label with $failure.label (report cleanup=$reportCleanup)",
    async ({ failure, combination, reportCleanup }) => {
      const result = await settleOwner({
        variant,
        combination,
        reportCleanup,
        value: failure.value,
      });

      expectSettlement(result.outcome, combination, reportCleanup, failure.value);
      expect(result.cleanupAttempts).toBe(1);
      expect(result.closeAttempts).toBe(1);
    },
  );
});

describe.each(["async", "sync"] as const)("%s atomic temp registration", (variant) => {
  it.each([false, true])(
    "retains exit cleanup after an unsuccessful unlink (report cleanup=%s)",
    async (reportCleanup) => {
      const root = await tempRoot(`fs-safe-temp-settlement-registration-${variant}-`);
      const pathname = path.join(root, "owned.tmp");
      await fs.writeFile(pathname, "owned");
      const identity = await fs.lstat(pathname, { bigint: true });
      const cleanupFailure = new Error("cleanup denied");
      let closeAttempts = 0;
      const outcome = await finishOwner({
        variant, pathname, identity, reportCleanup,
        unlink() { throw cleanupFailure; },
        close() { closeAttempts += 1; },
      });

      if (reportCleanup) {
        expect(Object.is(thrownValue(outcome), cleanupFailure)).toBe(true);
      } else {
        expectReturned(outcome);
      }
      expect(closeAttempts).toBe(1);
      await expect(fs.readFile(pathname, "utf8")).resolves.toBe("owned");

      consumeRetainedRegistration(pathname);
      await expect(fs.lstat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

describe.each(["async", "sync"] as const)("%s cleanup error inspection", (variant) => {
  it.each([false, true])("still treats a plain ENOENT as completed cleanup (report=%s)", async (
    reportCleanup,
  ) => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const result = await settleOwner({
      variant,
      combination: { label: "C", operation: false, cleanup: true, close: false },
      reportCleanup,
      value: missing,
    });
    expectReturned(result.outcome);
    expect(result.closeAttempts).toBe(1);
  });

  it("does not replace a hostile cleanup failure with property or coercion traps", async () => {
    const codeTrap = new Error("code getter must not escape");
    const coercionTrap = new Error("coercion must not escape");
    const hostile = new Proxy(Object.create(null) as object, {
      get(_target, property) {
        if (property === "code") throw codeTrap;
        if (property === Symbol.toPrimitive) throw coercionTrap;
        return undefined;
      },
    });
    const result = await settleOwner({
      variant,
      combination: { label: "C", operation: false, cleanup: true, close: false },
      reportCleanup: true,
      value: hostile,
    });
    const actual = thrownValue(result.outcome);
    expect(actual).toBeInstanceOf(Error);
    expect((actual as Error).message).toBe("<unprintable failure>");
    expect(Object.is(actual, codeTrap)).toBe(false);
    expect(Object.is(actual, coercionTrap)).toBe(false);
    expect(result.closeAttempts).toBe(1);
  });
});
