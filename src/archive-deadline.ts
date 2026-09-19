import { scheduleTimeout } from "./timing.js";

export type ExtractionDeadline = {
  signal: AbortSignal;
  check: () => void;
  ownDestinationMutation: <T>(run: () => Promise<T>) => Promise<T>;
  waitForDestinationMutations: () => Promise<void>;
  dispose: () => void;
};

export async function ownExtractionDestinationMutation<T>(
  deadline: ExtractionDeadline | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return deadline ? await deadline.ownDestinationMutation(run) : await run();
}

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
  // An elapsed synchronous check must not orphan a later operation rejection.
  void promise.catch(() => undefined);
  deadline.check();
  if (deadline.signal.aborted) {
    throw deadlineReason(deadline);
  }
  const result = await Promise.race([
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
  deadline.check();
  return result;
}

function createDestinationMutationOwner(check: () => void): Pick<
  ExtractionDeadline,
  "ownDestinationMutation" | "waitForDestinationMutations"
> {
  const active = new Set<Promise<unknown>>();
  return {
    ownDestinationMutation: async <T>(run: () => Promise<T>): Promise<T> => {
      check();
      const operation = Promise.resolve().then(() => { check(); return run(); });
      active.add(operation);
      try { return await operation; }
      finally { active.delete(operation); }
    },
    waitForDestinationMutations: async (): Promise<void> => {
      while (active.size > 0) {
        await Promise.allSettled(active);
      }
    },
  };
}

function createExtractionDeadline(timeoutMs: number, label: string): ExtractionDeadline {
  const controller = new AbortController();
  const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
  const enabled = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const startedAt = enabled ? performance.now() : 0;
  const check = (): void => {
    if (enabled && !controller.signal.aborted && performance.now() - startedAt >= timeoutMs) {
      controller.abort(timeoutError);
    }
    if (controller.signal.aborted) {
      throw signalReason(controller.signal, timeoutError);
    }
  };
  return {
    signal: controller.signal,
    check,
    ...createDestinationMutationOwner(check),
    dispose: enabled ? scheduleTimeout(() => controller.abort(timeoutError), timeoutMs) : () => undefined,
  };
}

export async function withExtractionDeadline<T>(
  timeoutMs: number,
  label: string,
  run: (deadline: ExtractionDeadline) => Promise<T>,
): Promise<T> {
  const deadline = createExtractionDeadline(timeoutMs, label);
  const operation = Promise.resolve().then(() => { deadline.check(); return run(deadline); });
  try {
    try {
      return await waitForDeadline(operation, deadline);
    } catch (error) {
      if (deadline.signal.aborted && error === deadlineReason(deadline)) {
        // Preserve prompt timeout settlement for non-mutating work, but never
        // return while live destination publication or rollback is still owned.
        await deadline.waitForDestinationMutations();
      }
      throw error;
    }
  } finally {
    deadline.dispose();
  }
}
