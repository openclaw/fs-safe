import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AsyncAtomicTempOwner,
  SyncAtomicTempOwner,
  type AtomicTempFailure,
} from "../src/replace-file-temp-owner.js";
import {
  __cleanupRegisteredTempPathForTest,
  __cleanupRegisteredTempPathsForTest,
} from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

type FailureValue = Readonly<{ label: string; value: unknown }>;
type FailureCombination = Readonly<{
  label: string;
  operation: boolean;
  cleanup: boolean;
  close: boolean;
}>;
type Captured =
  | Readonly<{ kind: "returned" }>
  | Readonly<{ kind: "threw"; error: unknown }>;

const FAILURE_VALUES: readonly FailureValue[] = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "false", value: false },
  { label: "+0", value: 0 },
  { label: "-0", value: -0 },
  { label: "0n", value: 0n },
  { label: "empty string", value: "" },
  { label: "NaN", value: Number.NaN },
  { label: "Error", value: new Error("control failure") },
];

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

async function captureAsync(run: () => Promise<unknown>): Promise<Captured> {
  try {
    await run();
    return { kind: "returned" };
  } catch (error) {
    return { kind: "threw", error };
  }
}

function captureSync(run: () => unknown): Captured {
  try {
    run();
    return { kind: "returned" };
  } catch (error) {
    return { kind: "threw", error };
  }
}

function consumeRetainedRegistration(pathname: string): void {
  const lstat = vi.spyOn(fsSync, "lstatSync");
  try {
    __cleanupRegisteredTempPathForTest(pathname);
    expect(lstat).toHaveBeenCalledWith(pathname, { bigint: true });
  } finally {
    lstat.mockRestore();
    fsSync.rmSync(pathname, { force: true });
  }
}

function expectReturned(outcome: Captured): void {
  expect(outcome.kind).toBe("returned");
}

function thrownValue(outcome: Captured): unknown {
  expect(outcome.kind).toBe("threw");
  if (outcome.kind !== "threw") throw new Error("Expected a thrown settlement");
  return outcome.error;
}

function expectNormalizedCleanup(actual: unknown, cleanup: unknown): void {
  if (cleanup instanceof Error) {
    expect(Object.is(actual, cleanup)).toBe(true);
    return;
  }
  expect(actual).toBeInstanceOf(Error);
  expect((actual as Error).message).toBe(String(cleanup));
}

function expectCleanupWrapper(actual: unknown, operation: unknown, cleanup: unknown): void {
  expect(actual).toBeInstanceOf(Error);
  expect(actual).not.toBeInstanceOf(AggregateError);
  const wrapped = actual as Error & { cause?: unknown };
  expect(Object.hasOwn(wrapped, "cause")).toBe(true);
  expect(Object.is(wrapped.cause, operation)).toBe(true);
  expect(wrapped.message).toBe(
    `Atomic file replace failed (${String(operation)}); cleanup also failed (${String(cleanup)})`,
  );
}

function expectAggregate(
  actual: unknown,
  message: string,
  assertFirst: (value: unknown) => void,
  second: unknown,
): void {
  expect(actual).toBeInstanceOf(AggregateError);
  const aggregate = actual as AggregateError;
  expect(aggregate.message).toBe(message);
  expect(aggregate.errors).toHaveLength(2);
  assertFirst(aggregate.errors[0]);
  expect(Object.is(aggregate.errors[1], second)).toBe(true);
}

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
  const originalFailure: AtomicTempFailure | undefined = params.combination.operation
    ? { error: params.value }
    : undefined;
  let cleanupAttempts = 0;
  let closeAttempts = 0;

  if (params.variant === "async") {
    const owner = new AsyncAtomicTempOwner(pathname);
    owner.start();
    owner.adopt({
      identity: OWNED_IDENTITY,
      handle: {
        close: async () => {
          closeAttempts += 1;
          if (params.combination.close) throw params.value;
        },
      } as FileHandle,
    });
    const outcome = await captureAsync(async () => await owner.finish({
      fsModule: {
        lstat: async () => OWNED_IDENTITY,
        unlink: async () => {
          cleanupAttempts += 1;
          if (params.combination.cleanup) throw params.value;
        },
      } as never,
      originalFailure,
      throwOnCleanupError: params.reportCleanup,
    }));
    __cleanupRegisteredTempPathForTest(pathname);
    return { outcome, cleanupAttempts, closeAttempts };
  }

  const owner = new SyncAtomicTempOwner(pathname);
  owner.start();
  owner.adopt({ fd: 47, identity: OWNED_IDENTITY });
  const outcome = captureSync(() => owner.finish({
    fsModule: {
      lstatSync: () => OWNED_IDENTITY,
      unlinkSync: () => {
        cleanupAttempts += 1;
        if (params.combination.cleanup) throw params.value;
      },
      closeSync: () => {
        closeAttempts += 1;
        if (params.combination.close) throw params.value;
      },
    } as never,
    originalFailure,
    throwOnCleanupError: params.reportCleanup,
  }));
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
      let outcome: Captured;

      if (variant === "async") {
        const owner = new AsyncAtomicTempOwner(pathname);
        owner.start();
        owner.adopt({
          identity,
          handle: {
            close: async () => {
              closeAttempts += 1;
            },
          } as FileHandle,
        });
        outcome = await captureAsync(async () => await owner.finish({
          fsModule: {
            lstat: async () => identity,
            unlink: async () => {
              throw cleanupFailure;
            },
          } as never,
          throwOnCleanupError: reportCleanup,
        }));
      } else {
        const owner = new SyncAtomicTempOwner(pathname);
        owner.start();
        owner.adopt({ fd: 53, identity });
        outcome = captureSync(() => owner.finish({
          fsModule: {
            lstatSync: () => identity,
            unlinkSync: () => {
              throw cleanupFailure;
            },
            closeSync: () => {
              closeAttempts += 1;
            },
          } as never,
          throwOnCleanupError: reportCleanup,
        }));
      }

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
