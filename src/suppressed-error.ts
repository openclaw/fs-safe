export type SuppressedErrorLike = Error & {
  error: unknown;
  suppressed: unknown;
};

type SuppressedErrorConstructor = new (
  error: unknown,
  suppressed: unknown,
  message?: string,
) => SuppressedErrorLike;

export function createSuppressedError(
  error: unknown,
  suppressed: unknown,
  message: string,
): SuppressedErrorLike {
  const constructor = (
    globalThis as typeof globalThis & { SuppressedError?: SuppressedErrorConstructor }
  ).SuppressedError;
  if (constructor) {
    return new constructor(error, suppressed, message);
  }
  const combined = new Error(message, {
    cause: error instanceof Error ? error : undefined,
  }) as SuppressedErrorLike;
  combined.name = "SuppressedError";
  Object.defineProperties(combined, {
    error: { configurable: true, value: error },
    suppressed: { configurable: true, value: suppressed },
  });
  return combined;
}
