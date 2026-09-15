import type { BigIntStats } from "node:fs";
import path from "node:path";
import { isPathInside } from "./path.js";

export type CapturedRemovalDirectory = Readonly<{
  path: string;
  stat: BigIntStats;
}>;

// Private to a single nonrecursive removal. No observations are shared across
// operations, and a lexical observation never stands in for an unvisited alias
// target on the final canonical chain.
export class RemovalPathReceipts {
  private rootStat: BigIntStats | undefined;
  private directories: Map<string, CapturedRemovalDirectory> | undefined;

  readonly observeRoot = (stat: BigIntStats): void => { this.rootStat = stat; };

  observeDirectory(dir: string, stat: BigIntStats): void {
    // Retain the first object if raw traversal revisits the same spelling.
    const directories = this.directories ??= new Map();
    if (!directories.has(dir)) directories.set(dir, { path: dir, stat });
  }

  complete(rootReal: string, targetPath: string): {
    rootStat: BigIntStats;
    parent: CapturedRemovalDirectory | undefined;
    directories: readonly CapturedRemovalDirectory[];
  } | undefined {
    const parentPath = path.dirname(targetPath);
    if (!this.rootStat || !isPathInside(rootReal, parentPath)) return undefined;
    const directories: CapturedRemovalDirectory[] = [];
    let current = parentPath;
    while (current !== rootReal) {
      // Exact spelling is intentional: case/namespace aliases and symlink hops
      // that did not visit the complete canonical chain use fresh admission.
      const directory = this.directories?.get(current);
      if (!directory) return undefined;
      directories.push(directory);
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
    directories.reverse();
    return { rootStat: this.rootStat, parent: directories.at(-1), directories };
  }
}
