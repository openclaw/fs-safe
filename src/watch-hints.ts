import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { assertRootIdentityCurrent, resolvePathInRoot, type RootContext } from "./root-context.js";
import { createRootDirectoryObservationGuard, assertRootDirectoryObservationGuard, type RootDirectoryObservationGuard } from "./root-directory-list.js";
import { lookupRootDirectoryEntry } from "./root-directory-entry.js";
import type { NativeWatchBatch } from "./watch-native.js";
import type { WatchSnapshot } from "./watch-scan.js";
import type { WatchChange, WatchScope } from "./watch-types.js";

function below(parent: string, child: string): boolean {
  return parent === "" ? child !== "" : child.startsWith(parent + path.sep);
}
function selectedByTree(scope: WatchScope, name: string, childDepth = 0): boolean {
  return scope.kind === "tree" && (scope.path === name ? childDepth <= scope.depth! : below(scope.path, name) &&
    (scope.path === "" ? name : name.slice(scope.path.length + 1)).split(path.sep).length + childDepth <= scope.depth!);
}
function addChange(result: Map<string, WatchChange>, change: WatchChange, limit: number): boolean {
  if (!result.has(change.path) && result.size >= limit) return false;
  const prior = result.get(change.path);
  result.set(change.path, prior?.type === "structural" ? prior : change);
  return true;
}
export function excludedWatchPath(snapshot: WatchSnapshot | undefined, name: string): boolean {
  const exclusions = snapshot?.excluded;
  if (exclusions?.has(name)) return true;
  while (name) {
    const parent = path.dirname(name);
    name = parent === "." ? "" : parent;
    if (exclusions?.get(name) === "directory") return true;
  }
  return false;
}
export function scopedChanges(scopes: readonly WatchScope[], change: WatchChange): WatchChange[] {
  const result = new Map<string, WatchChange>();
  for (const scope of scopes) {
    if (scope.path === change.path || selectedByTree(scope, change.path)) {
      result.set(change.path, change);
    } else if (below(change.path, scope.path)) {
      // A changed ancestor invalidates the requested target, not authority outside it.
      result.set(scope.path, { path: scope.path, type: "structural" });
    }
  }
  return [...result.values()];
}
/** An undecodable child cannot equal a validated literal scope component. */
export function selectedWatchChildren(scopes: readonly WatchScope[], directory: string): boolean {
  return scopes.some(scope => selectedByTree(scope, directory, 1));
}
/** A folded directory can contain a missing scope component, unlike a nameless child. */
export function selectedWatchSubtree(scopes: readonly WatchScope[], directory: string): boolean {
  return scopes.some(scope => scope.path === directory || below(directory, scope.path) ||
    selectedByTree(scope, directory));
}
function literalName(name: unknown): name is string {
  return typeof name === "string" && !!name && name !== "." && name !== ".." && !name.includes("\0") && !name.includes("/") &&
    (process.platform !== "win32" || !/[\\:]/.test(name));
}
export function nativeChanges(scopes: readonly WatchScope[], snapshot: WatchSnapshot | undefined, batch: NativeWatchBatch, limit = 256, after?: WatchSnapshot): WatchChange[] | undefined {
  if (batch.overflow) return undefined;
  const result = new Map<string, WatchChange>();
  for (const hint of batch.hints) {
    const name = hint.name;
    // Backend filenames are untrusted hints. Never resolve or perform I/O on them.
    if (typeof hint.directory !== "string" || (hint.directory && !hint.directory.split(path.sep).every(literalName))) return undefined;
    const children = hint.event === "children";
    const subtree = hint.event === "subtree";
    if (children || subtree ? name !== "" : !literalName(name)) return undefined;
    if (subtree) continue; // Folded hints only schedule guarded diff passes; never publish their spelling.
    if (children && !selectedWatchChildren(scopes, hint.directory)) continue;
    const relative = children ? hint.directory : hint.directory ? path.join(hint.directory, name) : name;
    if (excludedWatchPath(snapshot, relative) || excludedWatchPath(after, relative)) continue;
    for (const change of scopedChanges(scopes, {
      path: relative,
      type: hint.event === "change" && snapshot?.entries.get(relative)?.startsWith("file:") ? "content" : "structural",
    })) {
      if (!addChange(result, change, limit)) return undefined;
    }
  }
  return [...result.values()];
}
export function changedEntries(before: WatchSnapshot | undefined, after: WatchSnapshot, limit: number): WatchChange[] | undefined {
  if (!before) return undefined;
  const changes: WatchChange[] = [];
  const compare = (name: string): boolean => {
    const left = before.entries.get(name);
    const right = after.entries.get(name);
    if (left === right) return true;
    if (changes.length >= limit) return false;
    const sameFile = left?.startsWith("file:") && right?.startsWith("file:") &&
      left.split(":").slice(0, 3).join(":") === right.split(":").slice(0, 3).join(":");
    changes.push(Object.freeze({ path: name, type: sameFile ? "content" : "structural" }));
    return true;
  };
  for (const name of before.entries.keys()) if (!compare(name)) return undefined;
  for (const name of after.entries.keys()) if (!before.entries.has(name) && !compare(name)) return undefined;
  return changes;
}

/** Backend names never establish authority to publish a pathname. */
export function guardedHintChanges(
  scopes: readonly WatchScope[], before: WatchSnapshot | undefined, after: WatchSnapshot,
  hints: readonly WatchChange[] | undefined, observed: readonly WatchChange[] | undefined,
  limit: number,
): WatchChange[] | undefined {
  if (!hints || !observed) return undefined;
  const result = new Map(observed.map(change => [change.path, change]));
  for (const hint of hints) {
    // Drop unobserved non-target names only under a parent with the same guarded
    // identity in both passes; otherwise a stale/misdirected watch erases detail.
    if (!before?.entries.has(hint.path) && !after.entries.has(hint.path) && !scopes.some(scope => scope.path === hint.path)) {
      const parent = path.dirname(hint.path);
      const directory = parent === "." ? "" : parent;
      const left = before?.directories.get(directory), right = after.directories.get(directory);
      if (left && right && left.dev === right.dev && left.ino === right.ino) continue;
      return undefined;
    }
    // Equal snapshots cannot exclude an intermediate change and restoration (ABA).
    // Preserve admitted hints, including setup activity delivered after ready.
    if (!addChange(result, hint, limit)) return undefined;
    Object.freeze(result.get(hint.path));
  }
  return [...result.values()];
}

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
  for (const hint of batch.hints) {
    signal.throwIfAborted();
    if (hint.event === "subtree") {
      if (!scheduling) continue; // Only the full guarded snapshot supplies detail.
      if (selectedWatchSubtree(scopes, hint.directory)) return undefined;
      const guard = await admittedParent(hint.directory);
      for (const [name, identity] of candidates) {
        if (identity.dev === guard.stat.dev && identity.ino === guard.stat.ino && selectedWatchSubtree(scopes, name)) return undefined;
      }
      continue;
    }
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
        !addChange(result, { path: parent, type: "structural" }, limit)) return undefined;
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
      for (const change of selected) if (!addChange(result, change, limit)) return undefined;
      continue;
    }
    guard ??= await admittedParent(parent);
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
      for (const change of scopedChanges(scopes, { path: relative, type: "structural" })) if (!addChange(result, change, limit)) return undefined;
    }
    await assertRootDirectoryObservationGuard(root, guard);
  }
  for (const guard of guards.values()) await assertRootDirectoryObservationGuard(root, guard);
  await assertRootIdentityCurrent(root);
  signal.throwIfAborted();
  return [...result.values()];
}
