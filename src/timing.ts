export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sleepSync(ms: number): void {
  if (ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  labelOrOptions: string | { label?: string; message?: string; createError?: () => Error } = {
    message: "timeout",
  },
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await promise;
  }
  const options =
    typeof labelOrOptions === "string" ? { label: labelOrOptions } : labelOrOptions;
  const createError =
    options.createError ??
    (() =>
      new Error(options.message ?? `${options.label ?? "operation"} timed out after ${timeoutMs}ms`));
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          try {
            reject(createError());
          } catch (error) {
            reject(error);
          }
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
