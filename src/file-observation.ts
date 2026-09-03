import { AsyncLocalStorage } from "node:async_hooks";

type FailureKind = "identity" | "resolution" | `open:${string}` | `exclusive-create:${string}` | `unlinked:${string}` | `changed:${string}`;
const active = new AsyncLocalStorage<Map<unknown, Set<FailureKind>>>();

export function recordFileObservationFailure(error: unknown, kind: FailureKind): void {
  const failures = active.getStore();
  if (!failures) return;
  let kinds = failures.get(error);
  if (!kinds) failures.set(error, kinds = new Set());
  kinds.add(kind);
}

export function isFileObservationFailure(error: unknown, kind: FailureKind): boolean {
  return active.getStore()?.get(error)?.has(kind) === true;
}

// Each Root observation owns its receipts, including nested and concurrent reads.
export function fileObservation() {
  const failures = new Map<unknown, Set<FailureKind>>();
  return {
    run<T>(operation: () => T): T { return active.run(failures, operation); },
    has(error: unknown, kind: FailureKind): boolean { return failures.get(error)?.has(kind) === true; },
  };
}
