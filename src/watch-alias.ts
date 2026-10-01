import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { assertRootIdentityCurrent, resolvePathInRoot, type RootContext } from "./root-context.js";
import { createRootDirectoryObservationGuard, assertRootDirectoryObservationGuard, type RootDirectoryObservationGuard } from "./root-directory-list.js";
import { lookupRootDirectoryEntry } from "./root-directory-entry.js";
import { excludedWatchPath, nativeChanges, scopedChanges, selectedWatchChildren } from "./watch-hints.js";
import type { NativeWatchBatch } from "./watch-native.js";
import type { WatchSnapshot } from "./watch-scan.js";
import type { WatchChange, WatchScope } from "./watch-types.js";

/** Resolve native spelling aliases without treating case folding as identity. */
export async function admittedNativeChanges(
  root: RootContext, scopes: readonly WatchScope[], before: WatchSnapshot | undefined,
  after: WatchSnapshot, batch: NativeWatchBatch, signal: AbortSignal, limit: number,
  scheduling = false,
): Promise<WatchChange[] | undefined> {
  if (!nativeChanges(scopes, before, batch, limit, after)) return undefined;
  if (scheduling && !batch.hints.length) return undefined;
  const result = new Map<string, WatchChange>();
  const candidates = new Map([...before?.targets ?? [], ...after.targets, ...after.directories]);
  if (scheduling) {
    const identities = new Map<bigint, Set<bigint>>();
    for (const { dev, ino } of candidates.values()) {
      let inodes = identities.get(dev);
      if (!inodes) identities.set(dev, inodes = new Set());
      // One spelling cannot discard activity selected through another spelling,
      // including entry targets that alias a tree's directory without registering it.
      if (inodes.has(ino)) return undefined;
      inodes.add(ino);
    }
  }
  const guards = new Map<string, RootDirectoryObservationGuard>();
  const admittedParent = async (parent: string) => {
    let guard = guards.get(parent);
    if (!guard) {
      const resolved = await resolvePathInRoot(root, parent ? "./" + parent : ".", { rejectSymlinks: true });
      guard = await createRootDirectoryObservationGuard(root, resolved.resolved);
      const expected = after.directories.get(parent);
      if (expected && (guard.stat.dev !== expected.dev || guard.stat.ino !== expected.ino)) {
        throw new FsSafeError("path-mismatch", "watch hint parent changed during reconciliation");
      }
      guards.set(parent, guard);
    }
    await assertRootDirectoryObservationGuard(root, guard);
    signal.throwIfAborted();
    return guard;
  };
  if (scheduling) {
    // A sibling hint cannot hide a replaced scope anchor or its identity chain.
    for (const name of after.directories.keys()) if (scopes.some(scope =>
      !name || scope.path === name || scope.path.startsWith(name + path.sep))) await admittedParent(name);
    for (const scope of scopes) {
      const anchor = after.scopeAnchors?.get(scope.path);
      if (!anchor) return undefined;
      if (!anchor.name) continue;
      const guard = await admittedParent(anchor.directory);
      const found = await lookupRootDirectoryEntry(root, guard, anchor.name);
      signal.throwIfAborted();
      const expected = anchor.target;
      // Missing targets and vanished/replaced spelling aliases have no hint inode
      // to match. Recheck the selected spelling before declaring a batch unrelated.
      if (!found) { if (expected) return undefined; }
      else if (!expected || found.identity.dev !== expected.dev || found.identity.ino !== expected.ino ||
        (found.entry.isSymbolicLink ? "symlink" : found.entry.isDirectory ? "directory" : found.entry.isFile ? "file" : "other") !== expected.kind) return undefined;
    }
  }
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
    const relative = parent ? path.join(parent, name) : name;
    if (excludedWatchPath(before, relative) || excludedWatchPath(after, relative)) {
      if (scheduling) return undefined;
      continue;
    }
    let guard: RootDirectoryObservationGuard | undefined;
    let expected = after.directories.get(parent);
    if (!expected) {
      // Native recursion observes one Root handle and may report descendants of
      // unselected/entry-only directories. Admit a parent alias by exact identity,
      // not by lowercasing, and do not turn unselected descendants into events.
      try {
        guard = await admittedParent(parent);
      } catch (error) {
        await assertRootIdentityCurrent(root);
        if (scheduling) throw error;
        if (isNotFoundPathError(error) || (error instanceof FsSafeError && ["not-found", "path-alias", "outside-workspace", "symlink", "not-file"].includes(error.code))) continue;
        throw error;
      }
      const admitted = [...after.directories].find(([, identity]) => identity.dev === guard!.stat.dev && identity.ino === guard!.stat.ino);
      if (!admitted) {
        // A newly created directory may contain selected entries absent from the baseline.
        if (scheduling) return undefined;
        continue;
      }
      [parent, expected] = admitted;
    }
    if (scheduling) guard = await admittedParent(parent);
    if (hint.event === "children") {
      // There is no child spelling to look up. Only guarded scans may discover it.
      if (selectedWatchChildren(scopes, parent) && !excludedWatchPath(before, parent) && !excludedWatchPath(after, parent) &&
        !add({ path: parent, type: "structural" })) return undefined;
      continue;
    }
    const candidate = parent ? path.join(parent, name) : name;
    if (excludedWatchPath(before, candidate) || excludedWatchPath(after, candidate)) {
      if (scheduling) return undefined;
      continue;
    }
    const inspected = scheduling ? await lookupRootDirectoryEntry(root, guard!, name) : undefined;
    signal.throwIfAborted();
    // A vanished or multiply linked leaf may have changed selected entries in
    // another directory. Its current spelling cannot prove unrelatedness.
    if (scheduling && (!inspected || (!inspected.entry.isDirectory && inspected.entry.nlink !== 1))) return undefined;
    const selected = scopedChanges(scopes, { path: candidate,
      type: hint.event === "change" && before?.entries.get(candidate)?.startsWith("file:") ? "content" : "structural" });
    if (selected.length) {
      for (const change of selected) if (!add(change)) return undefined;
      continue;
    }
    if (!guard) {
      guard = await admittedParent(parent);
    }
    if (guard.stat.dev !== expected.dev || guard.stat.ino !== expected.ino) {
      throw new FsSafeError("path-mismatch", "watch hint parent changed during reconciliation");
    }
    const found = scheduling ? inspected : await lookupRootDirectoryEntry(root, guard, name);
    signal.throwIfAborted();
    // A missing unselected sibling is not evidence of lost selected detail.
    // Previously observed selected deletions remain visible in the snapshot diff;
    // an unseen, already-gone name has no identity proving a selected alias.
    if (!found) continue;
    if (scheduling && found.entry.isSymbolicLink) return undefined;
    for (const [relative, identity] of candidates) {
      if (!relative || identity.dev !== found.identity.dev || identity.ino !== found.identity.ino) continue;
      if ((path.dirname(relative) === "." ? "" : path.dirname(relative)) !== parent) {
        if (scheduling) return undefined;
        continue;
      }
      for (const change of scopedChanges(scopes, { path: relative, type: "structural" })) if (!add(change)) return undefined;
    }
    await assertRootDirectoryObservationGuard(root, guard);
  }
  for (const guard of guards.values()) await assertRootDirectoryObservationGuard(root, guard);
  await assertRootIdentityCurrent(root);
  signal.throwIfAborted();
  return [...result.values()];
}
