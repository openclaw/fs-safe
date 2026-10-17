import { FsSafeError, type FsSafeErrorCode } from "./errors.js";
import { createSuppressedError } from "./suppressed-error.js";

type ErrorWire = { name: string; message: string; code?: unknown; details?: Readonly<Record<string, unknown>>;
  cause?: unknown; error?: unknown; suppressed?: unknown };

export function encodeWatchError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const combined = error as Error & { error?: unknown; suppressed?: unknown };
  return {
    name: error.name, message: error.message, code: (error as NodeJS.ErrnoException).code,
    ...(error instanceof FsSafeError ? { details: error.details } : {}),
    cause: error.cause === undefined ? undefined : encodeWatchError(error.cause),
    ...(error.name === "SuppressedError" ? { error: encodeWatchError(combined.error), suppressed: encodeWatchError(combined.suppressed) } : {}),
  } satisfies ErrorWire;
}

export function decodeWatchError(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("message" in value) || typeof value.message !== "string") return value;
  const error = value as ErrorWire;
  if (error.name === "SuppressedError") return createSuppressedError(decodeWatchError(error.error), decodeWatchError(error.suppressed), error.message);
  const cause = error.cause === undefined ? undefined : decodeWatchError(error.cause);
  if (error.name === "FsSafeError") return new FsSafeError(error.code as FsSafeErrorCode, error.message, { cause, details: error.details });
  return Object.assign(new Error(error.message, { cause }), { name: error.name, code: error.code });
}
