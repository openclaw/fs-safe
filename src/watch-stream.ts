import path from "node:path";
import type { WatchSnapshot } from "./watch-scan.js";
import type { WatchScope } from "./watch-types.js";
import { watchYield } from "./watch-io.js";

export type WatchStreamPaths = { anchors: string[]; exclusions: string[] };
function shallowest(paths: Iterable<string>, limit: number): string[] {
  const result: string[] = [];
  const sorted = [...new Set(paths)].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  for (const name of sorted) {
    if (result.some(parent => name.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep))) continue;
    result.push(name);
    if (result.length === limit) break;
  }
  return result;
}
/** Canonical names come only from guarded directory observations, never backend hints. */
export function watchStreamPaths(snapshot: WatchSnapshot, scopes: readonly WatchScope[]): WatchStreamPaths {
  const anchors: string[] = [];
  for (const scope of scopes) {
    if (scope.kind === "entry") continue;
    let name = scope.kind === "tree" && scope.depth !== 0 ? scope.path : path.dirname(scope.path);
    if (name === ".") name = "";
    while (!snapshot.directoryPaths?.has(name)) {
      if (!name) break;
      const parent = path.dirname(name);
      name = parent === "." ? "" : parent;
    }
    const canonical = snapshot.directoryPaths?.get(name);
    if (canonical) anchors.push(canonical);
  }
  return { anchors: shallowest(anchors, 128), exclusions: shallowest(snapshot.excludedDirectories?.values() ?? [], 8) };
}

/** Avoid a tree-sized sort on the host when many directories are excluded. */
export async function watchStreamPathsAsync(snapshot: WatchSnapshot, scopes: readonly WatchScope[]): Promise<WatchStreamPaths> {
  const result = watchStreamPaths({ ...snapshot, excludedDirectories: undefined }, scopes);
  const checkpoint = watchYield();
  for (let n = 0; n < 8; n++) {
    let selected: string | undefined, depth = Infinity;
    for (const name of snapshot.excludedDirectories?.values() ?? []) {
      await checkpoint();
      if (result.exclusions.some(parent => name === parent || name.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep))) continue;
      const nextDepth = name.split(path.sep).length;
      if (nextDepth < depth || (nextDepth === depth && name.localeCompare(selected!) < 0)) { selected = name; depth = nextDepth; }
    }
    if (selected === undefined) break;
    result.exclusions.push(selected);
  }
  return result;
}
