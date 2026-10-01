import fsSync from "node:fs";
import { expect, vi } from "vitest";
import { __cleanupRegisteredTempPathForTest } from "../../src/temp-cleanup.js";

export type FailureValue = Readonly<{ label: string; value: unknown }>;
export type Captured =
  | Readonly<{ kind: "returned" }>
  | Readonly<{ kind: "threw"; error: unknown }>;

export const FAILURE_VALUES: readonly FailureValue[] = [
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

export async function captureAsync(run: () => Promise<unknown>): Promise<Captured> {
  try {
    await run();
    return { kind: "returned" };
  } catch (error) {
    return { kind: "threw", error };
  }
}

export function captureSync(run: () => unknown): Captured {
  try {
    run();
    return { kind: "returned" };
  } catch (error) {
    return { kind: "threw", error };
  }
}

export function consumeRetainedRegistration(pathname: string): void {
  const lstat = vi.spyOn(fsSync, "lstatSync");
  try {
    __cleanupRegisteredTempPathForTest(pathname);
    expect(lstat).toHaveBeenCalledWith(pathname, { bigint: true });
  } finally {
    lstat.mockRestore();
    fsSync.rmSync(pathname, { force: true });
  }
}

export function expectReturned(outcome: Captured): void {
  expect(outcome.kind).toBe("returned");
}

export function thrownValue(outcome: Captured): unknown {
  expect(outcome.kind).toBe("threw");
  if (outcome.kind !== "threw") throw new Error("Expected a thrown settlement");
  return outcome.error;
}

export function expectNormalizedCleanup(actual: unknown, cleanup: unknown): void {
  if (cleanup instanceof Error) {
    expect(Object.is(actual, cleanup)).toBe(true);
    return;
  }
  expect(actual).toBeInstanceOf(Error);
  expect((actual as Error).message).toBe(String(cleanup));
}

export function expectCleanupWrapper(actual: unknown, operation: unknown, cleanup: unknown): void {
  expect(actual).toBeInstanceOf(Error);
  expect(actual).not.toBeInstanceOf(AggregateError);
  const wrapped = actual as Error & { cause?: unknown };
  expect(Object.hasOwn(wrapped, "cause")).toBe(true);
  expect(Object.is(wrapped.cause, operation)).toBe(true);
  expect(wrapped.message).toBe(
    `Atomic file replace failed (${String(operation)}); cleanup also failed (${String(cleanup)})`,
  );
}

export function expectAggregate(
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
