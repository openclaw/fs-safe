import path from "node:path";
import type { WatchSnapshot } from "./watch-scan.js";
import type { WatchScope } from "./watch-types.js";

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
