import path from "node:path";
import type { NativeWatchBatch } from "./watch-native.js";
import type { WatchSnapshot } from "./watch-scan.js";
import type { WatchChange, WatchScope } from "./watch-types.js";

function below(parent: string, child: string): boolean {
  return parent === "" ? child !== "" : child.startsWith(parent + path.sep);
}
function distance(parent: string, child: string): number {
  return (parent === "" ? child : child.slice(parent.length + 1)).split(path.sep).length;
}
export function scopedChanges(scopes: readonly WatchScope[], change: WatchChange): WatchChange[] {
  const result = new Map<string, WatchChange>();
  for (const scope of scopes) {
    if (scope.path === change.path || (scope.kind === "tree" && below(scope.path, change.path) && distance(scope.path, change.path) <= scope.depth!)) {
      result.set(change.path, change);
    } else if (below(change.path, scope.path)) {
      // A changed ancestor invalidates the requested target, not authority outside it.
      result.set(scope.path, { path: scope.path, type: "structural" });
    }
  }
  return [...result.values()];
}
export function nativeChanges(scopes: readonly WatchScope[], snapshot: WatchSnapshot | undefined, batch: NativeWatchBatch, limit = 256): WatchChange[] | undefined {
  if (batch.overflow) return undefined;
  const result = new Map<string, WatchChange>();
  for (const hint of batch.hints) {
    const name = hint.name;
    // Backend filenames are untrusted hints. Never resolve or perform I/O on them.
    if (typeof name !== "string" || !name || name === "." || name === ".." || name.includes("\0") || name.includes("/") || (process.platform === "win32" && /[\\:]/.test(name))) return undefined;
    const relative = hint.directory ? path.join(hint.directory, name) : name;
    for (const change of scopedChanges(scopes, {
      path: relative,
      type: hint.event === "change" && snapshot?.entries.get(relative)?.startsWith("file:") ? "content" : "structural",
    })) {
      if (!result.has(change.path) && result.size >= limit) return undefined;
      const prior = result.get(change.path);
      result.set(change.path, prior?.type === "structural" ? prior : change);
    }
  }
  return [...result.values()];
}
export function changedEntries(before: WatchSnapshot | undefined, after: WatchSnapshot, limit: number): WatchChange[] | undefined {
  if (!before) return undefined;
  const changes: WatchChange[] = [];
  for (const name of new Set([...before.entries.keys(), ...after.entries.keys()])) {
    const left = before.entries.get(name);
    const right = after.entries.get(name);
    if (left === right) continue;
    if (changes.length >= limit) return undefined;
    const sameFile = left?.startsWith("file:") && right?.startsWith("file:") &&
      left.split(":").slice(0, 3).join(":") === right.split(":").slice(0, 3).join(":");
    changes.push(Object.freeze({ path: name, type: sameFile ? "content" : "structural" }));
  }
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
    // Only publish an independently observed name (including a deletion from
    // the previous guarded snapshot), or a target explicitly supplied by caller.
    // A stale/misdirected inode watch may report outside names: erase its detail.
    if (!before?.entries.has(hint.path) && !after.entries.has(hint.path) && !scopes.some(scope => scope.path === hint.path)) return undefined;
    if (!result.has(hint.path) && result.size >= limit) return undefined;
    const prior = result.get(hint.path);
    result.set(hint.path, Object.freeze(prior?.type === "structural" ? prior : hint));
  }
  return [...result.values()];
}
