import type { BigIntStats } from "node:fs";
import path from "node:path";
import { isPathInside } from "./path.js";

// Private to a single nonrecursive removal. No observations are shared across
// operations, and a lexical observation never stands in for an unvisited alias
// target on the final canonical chain.
export class RemovalPathReceipts {
  private rootStat: BigIntStats | undefined;
  private readonly directories = new Map<string, BigIntStats>();

  readonly observeRoot = (stat: BigIntStats): void => { this.rootStat = stat; };

  observeDirectory(dir: string, stat: BigIntStats): void {
    // Retain the first object if raw traversal revisits the same spelling.
    if (!this.directories.has(dir)) this.directories.set(dir, stat);
  }

  complete(rootReal: string, targetPath: string): {
    rootStat: BigIntStats;
    parentStat: BigIntStats;
    directories: readonly BigIntStats[];
  } | undefined {
    const parentPath = path.dirname(targetPath);
    if (!this.rootStat || !isPathInside(rootReal, parentPath)) return undefined;
    const paths: string[] = [];
    let current = parentPath;
    while (current !== rootReal) {
      // Exact spelling is intentional: case/namespace aliases and symlink hops
      // that did not visit the complete canonical chain use fresh admission.
      if (!this.directories.has(current)) return undefined;
      paths.push(current);
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
    const directories = paths.reverse().map(dir => this.directories.get(dir)!);
    return { rootStat: this.rootStat, parentStat: directories.at(-1) ?? this.rootStat, directories };
  }
}
