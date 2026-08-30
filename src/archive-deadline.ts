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

function createDestinationMutationOwner(check: () => void): Pick<
  ExtractionDeadline,
  "ownDestinationMutation" | "waitForDestinationMutations"
> {
  const active = new Set<Promise<void>>();
  return {
    ownDestinationMutation: async <T>(run: () => Promise<T>): Promise<T> => {
      check();
      const operation = Promise.resolve().then(run);
      const tracked = operation.then(
        () => undefined,
        () => undefined,
      );
      active.add(tracked);
      void tracked.finally(() => active.delete(tracked));
      return await operation;
    },
    waitForDestinationMutations: async (): Promise<void> => {
      while (active.size > 0) {
        await Promise.all(active);
      }
    },
  };
}

function createExtractionDeadline(timeoutMs: number, label: string): ExtractionDeadline {
  const controller = new AbortController();
  const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
  const check = (): void => {
    if (controller.signal.aborted) {
      throw signalReason(controller.signal, timeoutError);
    }
  };
  const mutationOwner = createDestinationMutationOwner(check);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      signal: controller.signal,
      check,
      ...mutationOwner,
      dispose: () => undefined,
    };
  }
  const timeoutId = setTimeout(() => {
    controller.abort(timeoutError);
  }, timeoutMs);
  return {
    signal: controller.signal,
    check,
    ...mutationOwner,
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
