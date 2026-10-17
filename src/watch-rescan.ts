import { watchYield } from "./watch-io.js";
import path from "node:path";
import type { WatchChange, WatchScope } from "./watch-types.js";
import type { WatchSnapshot } from "./watch-scan.js";

const parent = (name: string) => path.dirname(name) === "." ? "" : path.dirname(name);
const below = (directory: string, name: string) => !directory || name.startsWith(directory + path.sep);
const identity = (fingerprint: string | undefined) => fingerprint?.split(":").slice(0, 3).join(":");

/** Only previously enumerated directories can be reconciled without discovering topology. */
export function watchRescanScopes(scopes: readonly WatchScope[], snapshot: WatchSnapshot, changes: readonly WatchChange[]): readonly WatchScope[] | undefined {
  if (scopes.some((scope, index) => scope.kind === "tree" && scope.depth! > 0 && scopes.some((other, next) =>
    index !== next && (scope.path === other.path || below(scope.path, other.path))))) return;
  const directories = new Set<string>();
  for (const change of changes) {
    // A directory hint can cover descendant edits and new native registrations.
    if (snapshot.listed?.has(change.path)) return undefined;
    if (scopes.some(scope => scope.path === change.path && scope.kind === "tree" && scope.depth! > 0)) return undefined;
    if (scopes.some(scope => scope.path === change.path)) continue;
    const directory = parent(change.path);
    if (!snapshot.listed?.has(directory)) return undefined;
    directories.add(directory);
  }
  return [
    ...scopes.map(scope => ({ ...scope, depth: 0 })),
    ...[...directories].map(name => ({ path: name, kind: "tree" as const, depth: 1 })),
  ];
}

/** Merge only freshly observed slices. Any topology/anchor ambiguity requires a full pass. */
export async function mergeWatchRescan(scopes: readonly WatchScope[], before: WatchSnapshot, slice: WatchSnapshot, requested: readonly WatchScope[]): Promise<WatchSnapshot | undefined> {
  const checkpoint = watchYield();
  const copy = async <K, V>(entries?: Iterable<readonly [K, V]>): Promise<Map<K, V>> => {
    const result = new Map<K, V>();
    for (const [key, value] of entries ?? []) { result.set(key, value); await checkpoint(); }
    return result;
  };
  const combine = async <K, V>(left?: Iterable<readonly [K, V]>, right?: Iterable<readonly [K, V]>) => {
    const result = await copy(left);
    for (const [key, value] of right ?? []) { result.set(key, value); await checkpoint(); }
    return result;
  };
  if (before.overflow || before.structural?.size || slice.overflow || slice.structural?.size) return;
  // An exclusion or a blocked path may stop before a requested directory is listed.
  for (const scope of requested) if (scope.kind === "tree" && scope.depth! > 0 && !slice.listed?.has(scope.path)) return;
  for (const [name, current] of slice.directories) {
    await checkpoint();
    const prior = before.directories.get(name);
    if (!prior || prior.dev !== current.dev || prior.ino !== current.ino) return;
  }
  for (const scope of scopes) {
    if (identity(before.entries.get(scope.path)) !== identity(slice.entries.get(scope.path))) return;
    // A missing/blocked intermediate scope must not retain old descendant registrations.
    for (const name of before.directories.keys()) {
      await checkpoint();
      if ((name === scope.path || below(name, scope.path)) && !slice.directories.has(name) && name !== scope.path) return;
    }
  }
  const directories = slice.listed!;
  const selected = new Set(scopes.map(scope => scope.path));
  for (const directory of directories.keys()) {
    for (const name of before.childPaths?.get(directory)?.values() ?? []) { selected.add(name); await checkpoint(); }
    for (const name of slice.childPaths?.get(directory)?.values() ?? []) { selected.add(name); await checkpoint(); }
  }
  for (const name of selected) {
    await checkpoint();
    const previous = before.entries.get(name), current = slice.entries.get(name);
    if ((previous?.startsWith("directory:") || current?.startsWith("directory:")) && identity(previous) !== identity(current)) return;
  }
  // Exclusion changes can retire or admit a subtree, including callback-driven changes.
  for (const [name, kind] of before.excluded ?? []) {
    await checkpoint();
    if (selected.has(name) && kind === "directory" && slice.entries.has(name)) return;
  }
  const entries = await copy(before.entries);
  for (const name of selected) { await checkpoint(); if (!slice.entries.has(name)) entries.delete(name); }
  for (const [name, value] of slice.entries) { await checkpoint(); if (selected.has(name)) entries.set(name, value); }
  const excluded = await copy(before.excluded), excludedDirectories = await copy(before.excludedDirectories);
  for (const name of selected) { await checkpoint(); excluded.delete(name); excludedDirectories.delete(name); }
  for (const [name, kind] of slice.excluded ?? []) {
    await checkpoint();
    if (!selected.has(name)) continue;
    excluded.set(name, kind);
    const canonical = slice.excludedDirectories?.get(name);
    if (canonical) excludedDirectories.set(name, canonical);
  }
  const listed = await copy(before.listed);
  let scanned = before.scanned;
  for (const [name, count] of directories) {
    await checkpoint();
    scanned += count - (listed.get(name) ?? 0);
    listed.set(name, count);
  }
  const observations = before.observations && slice.observations ? await copy(before.observations) : undefined;
  if (observations) {
    for (const name of selected) { await checkpoint(); if (!slice.observations!.has(name)) observations.delete(name); }
    for (const [name, observation] of slice.observations!) {
      await checkpoint();
      // A parent's listing can observe a child's new timestamps without reading
      // its children. Keep the old stamp until that directory is actually listed.
      if (before.listed?.has(name) && !directories.has(name)) continue;
      observations.set(name, observation);
    }
  }
  const unsettled = new Set<string>();
  for (const name of before.unsettled ?? []) { await checkpoint(); if (!directories.has(name)) unsettled.add(name); }
  for (const name of slice.unsettled ?? []) { await checkpoint(); unsettled.add(name); }
  return { ...before, entries, excluded, excludedDirectories, listed, scanned, unsettled,
    entryAnchors: slice.entryAnchors,
    scopeAnchors: new Map(scopes.flatMap(scope => {
      const anchor = slice.scopeAnchors?.get(scope.path);
      return anchor ? [[scope.path, anchor] as const] : [];
    })),
    directoryPaths: await combine(before.directoryPaths, slice.directoryPaths),
    childPaths: await combine(before.childPaths, slice.childPaths),
    listingPaths: await combine(before.listingPaths, slice.listingPaths),
    observations,
    targets: new Map(scopes.flatMap(scope => {
      const target = slice.targets.get(scope.path);
      return target ? [[scope.path, target] as const] : [];
    })), structural: slice.structural, overflow: false,
  };
}
