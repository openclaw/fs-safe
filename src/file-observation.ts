import { AsyncLocalStorage } from "node:async_hooks";

type FailureKind = "hardlink" | "identity" | "resolution" | `open:${string}` | `sidecar-create-denial:${string}` | `exclusive-create:${string}` | `unlinked:${string}` | `changed:${string}` | `linked-change:${string}` | `stat-leaf-missing:${string}` | `stat-leaf-changed:${string}`;
type ObservationContext = {
  failures: Map<unknown, Set<FailureKind>>;
  publicationPending?: (filePath: string, identity: { dev: bigint; ino: bigint }) => Promise<boolean>;
};
const active = new AsyncLocalStorage<ObservationContext>();

export function recordFileObservationFailure(error: unknown, kind: FailureKind): void {
  const failures = active.getStore()?.failures;
  if (!failures) return;
  let kinds = failures.get(error);
  if (!kinds) failures.set(error, kinds = new Set());
  kinds.add(kind);
}

export function isFileObservationFailure(error: unknown, kind: FailureKind): boolean {
  return active.getStore()?.failures.get(error)?.has(kind) === true;
}

export async function observedFilePublicationPending(filePath: string, identity: { dev: bigint; ino: bigint }): Promise<boolean> {
  return await active.getStore()?.publicationPending?.(filePath, identity) ?? false;
}

// Each Root observation owns its receipts, including nested and concurrent reads.
export function fileObservation(options: Pick<ObservationContext, "publicationPending"> = {}) {
  const failures = new Map<unknown, Set<FailureKind>>();
  const context = { failures, ...options };
  return {
    run<T>(operation: () => T): T { return active.run(context, operation); },
    has(error: unknown, kind: FailureKind): boolean { return failures.get(error)?.has(kind) === true; },
  };
}
