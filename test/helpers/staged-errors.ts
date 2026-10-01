import { expect } from "vitest";
import { FsSafeError, type FsSafeErrorCode } from "../../src/errors.js";

export async function rejection(operation: Promise<unknown>): Promise<{ error: unknown }> {
  return operation.then(
    () => { throw new Error("expected operation to reject"); },
    (error: unknown) => ({ error }),
  );
}

export function assertWrapped(error: unknown, cause: unknown, code: FsSafeErrorCode = "helper-failed"): FsSafeError {
  let wrapped = false;
  try { wrapped = error instanceof FsSafeError; } catch { /* A hostile raw value is not a wrapper. */ }
  expect(wrapped).toBe(true);
  const result = error as FsSafeError;
  expect(result.code).toBe(code);
  // Never ask an assertion formatter to inspect the hostile cause.
  expect(result.cause === cause).toBe(true);
  return result;
}

export const hostileErrors = [
  {
    label: "throwing code getter",
    create: () => Object.defineProperty(new Error("caller failure"), "code", {
      get() { throw new Error("code must not escape classification"); },
    }),
  },
  {
    label: "revoked proxy",
    create: () => {
      const { proxy, revoke } = Proxy.revocable(new Error("caller failure"), {});
      revoke();
      return proxy;
    },
  },
  {
    label: "throwing prototype lookup",
    create: () => new Proxy(new Error("caller failure"), {
      getPrototypeOf() { throw new Error("prototype must not escape classification"); },
    }),
  },
];
