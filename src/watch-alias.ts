import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { assertRootIdentityCurrent, resolvePathInRoot, type RootContext } from "./root-context.js";
import { createRootDirectoryObservationGuard, assertRootDirectoryObservationGuard, type RootDirectoryObservationGuard } from "./root-directory-list.js";
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
  if (!nativeChanges(scopes, before, batch, limit)) return undefined;
  const result = new Map<string, WatchChange>();
  const candidates = new Map([...before?.targets ?? [], ...after.targets, ...after.directories]);
  const add = (change: WatchChange) => {
    if (!result.has(change.path) && result.size >= limit) return false;
    const prior = result.get(change.path);
    result.set(change.path, prior?.type === "structural" ? prior : change);
    return true;
  };
  for (const hint of batch.hints) {
    signal.throwIfAborted();
    const name = hint.name!; // nativeChanges rejected unknown or non-literal names.
    let parent = hint.directory;
    let guard: RootDirectoryObservationGuard | undefined;
    let expected = after.directories.get(parent);
    if (!expected) {
      // Native recursion observes one Root handle and may report descendants of
      // unselected/entry-only directories. Admit a parent alias by exact identity,
      // not by lowercasing, and do not turn unselected descendants into events.
      try {
        const resolved = await resolvePathInRoot(root, parent ? "./" + parent : ".", { rejectSymlinks: true });
        guard = await createRootDirectoryObservationGuard(root, resolved.resolved);
      } catch (error) {
        await assertRootIdentityCurrent(root);
        if (isNotFoundPathError(error) || (error instanceof FsSafeError && ["not-found", "path-alias", "outside-workspace", "symlink", "not-file"].includes(error.code))) continue;
        throw error;
      }
      const admitted = [...after.directories].find(([, identity]) => identity.dev === guard!.stat.dev && identity.ino === guard!.stat.ino);
      if (!admitted) continue;
      [parent, expected] = admitted;
    }
    const candidate = parent ? path.join(parent, name) : name;
    const selected = scopedChanges(scopes, { path: candidate,
      type: hint.event === "change" && before?.entries.get(candidate)?.startsWith("file:") ? "content" : "structural" });
    if (selected.length) {
      for (const change of selected) if (!add(change)) return undefined;
      continue;
    }
    if (!guard) {
      const resolved = await resolvePathInRoot(root, parent ? "./" + parent : ".", { rejectSymlinks: true });
      guard = await createRootDirectoryObservationGuard(root, resolved.resolved);
    }
    if (guard.stat.dev !== expected.dev || guard.stat.ino !== expected.ino) {
      throw new FsSafeError("path-mismatch", "watch hint parent changed during reconciliation");
    }
    const found = await lookupRootDirectoryEntry(root, guard, name);
    signal.throwIfAborted();
    if (!found) return undefined; // Could be a deleted short-name/case alias.
    for (const [relative, identity] of candidates) {
      if (!relative || (path.dirname(relative) === "." ? "" : path.dirname(relative)) !== parent) continue;
      if (identity.dev !== found.identity.dev || identity.ino !== found.identity.ino) continue;
      for (const change of scopedChanges(scopes, { path: relative, type: "structural" })) if (!add(change)) return undefined;
    }
    await assertRootDirectoryObservationGuard(root, guard);
  }
  await assertRootIdentityCurrent(root);
  signal.throwIfAborted();
  return [...result.values()];
}
