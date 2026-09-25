import path from "node:path";
import { FsSafeError } from "./errors.js";
import { assertRootIdentityCurrent, resolvePathInRoot, type RootContext } from "./root-context.js";
import { createRootDirectoryObservationGuard, assertRootDirectoryObservationGuard } from "./root-directory-list.js";
import { lookupRootDirectoryEntry } from "./root-directory-entry.js";
import { nativeChanges, scopedChanges } from "./watch-hints.js";
import type { NodeWatchBatch } from "./watch-node.js";
import type { WatchSnapshot } from "./watch-scan.js";
import type { WatchChange, WatchScope } from "./watch-types.js";

/** Resolve native spelling aliases without treating case folding as identity. */
export async function admittedNativeChanges(
  root: RootContext, scopes: readonly WatchScope[], before: WatchSnapshot | undefined,
  after: WatchSnapshot, batch: NodeWatchBatch, signal: AbortSignal, limit: number,
): Promise<WatchChange[] | undefined> {
  const matched = nativeChanges(scopes, before, batch, limit);
  if (!matched) return undefined;
  const result = new Map(matched.map(change => [change.path, change]));
  for (const hint of batch.hints) {
    signal.throwIfAborted();
    const name = hint.name!; // nativeChanges rejected unknown or non-literal names.
    const candidate = hint.directory ? path.join(hint.directory, name) : name;
    if (scopedChanges(scopes, { path: candidate, type: "structural" }).length) continue;
    const expected = after.directories.get(hint.directory);
    if (!expected) return undefined;
    const resolved = await resolvePathInRoot(root, hint.directory ? "./" + hint.directory : ".", { rejectSymlinks: true });
    const guard = await createRootDirectoryObservationGuard(root, resolved.resolved);
    if (guard.stat.dev !== expected.dev || guard.stat.ino !== expected.ino) {
      throw new FsSafeError("path-mismatch", "watch hint parent changed during reconciliation");
    }
    const found = await lookupRootDirectoryEntry(root, guard, name);
    signal.throwIfAborted();
    if (!found) return undefined; // Could be a deleted short-name/case alias.
    const candidates = new Map([...before?.targets ?? [], ...after.targets, ...after.directories]);
    for (const [relative, identity] of candidates) {
      if (!relative || (path.dirname(relative) === "." ? "" : path.dirname(relative)) !== hint.directory) continue;
      if (identity.dev !== found.identity.dev || identity.ino !== found.identity.ino) continue;
      for (const change of scopedChanges(scopes, { path: relative, type: "structural" })) {
        if (!result.has(change.path) && result.size >= limit) return undefined;
        result.set(change.path, change);
      }
    }
    await assertRootDirectoryObservationGuard(root, guard);
  }
  await assertRootIdentityCurrent(root);
  signal.throwIfAborted();
  return [...result.values()];
}
