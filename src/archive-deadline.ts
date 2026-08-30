export type ExtractionDeadline = {
  signal: AbortSignal;
  check: () => void;
  dispose: () => void;
};

function signalReason(signal: AbortSignal, fallback?: Error): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : fallback ?? new Error(String(reason));
}

function deadlineReason(deadline: ExtractionDeadline): Error {
  return signalReason(deadline.signal);
}

export function createPipelineTimeoutError(
  err: unknown,
  deadline: ExtractionDeadline,
): unknown {
  if (
    deadline.signal.aborted &&
    err instanceof Error &&
    (err.name === "AbortError" || err.message === "The operation was aborted")
  ) {
    return deadlineReason(deadline);
  }
  return err;
}

export async function waitForDeadline<T>(
  promise: Promise<T>,
  deadline: ExtractionDeadline,
): Promise<T> {
  deadline.check();
  if (deadline.signal.aborted) {
    throw deadlineReason(deadline);
  }
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const abort = () => reject(deadlineReason(deadline));
      deadline.signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        deadline.signal.removeEventListener("abort", abort);
      };
      promise.then(cleanup, cleanup);
    }),
  ]);
}

function createExtractionDeadline(timeoutMs: number, label: string): ExtractionDeadline {
  const controller = new AbortController();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      signal: controller.signal,
      check: () => undefined,
      dispose: () => undefined,
    };
  }
  const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
  const timeoutId = setTimeout(() => {
    controller.abort(timeoutError);
  }, timeoutMs);
  return {
    signal: controller.signal,
    check: () => {
      if (controller.signal.aborted) {
        throw signalReason(controller.signal, timeoutError);
      }
    },
    dispose: () => {
      clearTimeout(timeoutId);
    },
  };
}

export async function withExtractionDeadline<T>(
  timeoutMs: number,
  label: string,
  run: (deadline: ExtractionDeadline) => Promise<T>,
): Promise<T> {
  const deadline = createExtractionDeadline(timeoutMs, label);
  const operation = Promise.resolve().then(async () => await run(deadline));
  try {
    deadline.check();
    try {
      return await waitForDeadline(operation, deadline);
    } catch (error) {
      if (deadline.signal.aborted && error === deadlineReason(deadline)) {
        // The deadline requests cancellation, but extraction still owns staging,
        // descriptors, and destination mutations until the operation unwinds.
        await operation.catch(() => undefined);
      }
      throw error;
    }
  } finally {
    deadline.dispose();
  }
}
