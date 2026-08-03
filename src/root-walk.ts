import path from "node:path";
import { FsSafeError } from "./errors.js";
import { resolveRootPath } from "./root-path.js";
import type { DirEntry } from "./types.js";

export type RootWalkSymlinkPolicy = "skip" | "follow-within-root";
export type RootWalkLimitBehavior = "truncate" | "throw";
export type RootWalkDirectoryErrorBehavior = "throw" | "skip-and-report";
export type RootWalkEntryFilterResult = "include" | "skip" | "skip-subtree";
export type RootWalkDataEntryKind = "file" | "directory" | "other";
export type RootWalkEntryKind = RootWalkDataEntryKind | "directory-error" | "truncated";

export type RootWalkDataEntry = {
  relativePath: string;
  kind: RootWalkDataEntryKind;
  size: number;
};

export type RootWalkEntry =
  | RootWalkDataEntry
  | { relativePath: string; kind: "truncated"; size: 0 }
  | { relativePath: string; kind: "directory-error"; size: 0; error: unknown };

export type RootWalkEntryFilter = (entry: RootWalkDataEntry) => RootWalkEntryFilterResult;

export type RootWalkOptions = {
  maxDepth?: number;
  maxEntries?: number;
  symlinkPolicy: RootWalkSymlinkPolicy;
  signal?: AbortSignal;
  limitBehavior?: RootWalkLimitBehavior;
  entryFilter?: RootWalkEntryFilter;
  onDirectoryError?: RootWalkDirectoryErrorBehavior;
};

type RootWalkCapability = {
  rootReal: string;
  list(relativePath: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
};

function validateBudget(name: string, value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function entryKind(entry: DirEntry): RootWalkDataEntryKind | "symlink" {
  if (entry.isSymbolicLink) return "symlink";
  if (entry.isDirectory) return "directory";
  if (entry.isFile) return "file";
  return "other";
}

function limitEntry(relativePath: string): RootWalkEntry {
  return { relativePath, kind: "truncated", size: 0 };
}

export async function* walkRoot(
  root: RootWalkCapability,
  relativePath: string,
  options: RootWalkOptions,
): AsyncGenerator<RootWalkEntry> {
  if (!(["skip", "follow-within-root"] as const).includes(options.symlinkPolicy)) {
    throw new TypeError(`invalid root walk symlink policy: ${String(options.symlinkPolicy)}`);
  }
  if (
    options.limitBehavior !== undefined &&
    !(["truncate", "throw"] as const).includes(options.limitBehavior)
  ) {
    throw new TypeError(`invalid root walk limit behavior: ${String(options.limitBehavior)}`);
  }
  if (
    options.onDirectoryError !== undefined &&
    !(["throw", "skip-and-report"] as const).includes(options.onDirectoryError)
  ) {
    throw new TypeError(
      `invalid root walk directory error behavior: ${String(options.onDirectoryError)}`,
    );
  }
  const maxDepth = validateBudget("maxDepth", options.maxDepth);
  const maxEntries = validateBudget("maxEntries", options.maxEntries);
  const visitedDirectories = new Set<string>();
  let examined = 0;

  const onLimit = (atPath: string): RootWalkEntry => {
    if ((options.limitBehavior ?? "truncate") === "throw") {
      throw new FsSafeError("too-large", `root walk budget exceeded at ${atPath || "."}`);
    }
    return limitEntry(atPath);
  };

  async function* visit(directory: string, depth: number): AsyncGenerator<RootWalkEntry> {
    options.signal?.throwIfAborted();
    let entries: DirEntry[];
    try {
      const resolvedDirectory = await resolveRootPath({
        absolutePath: path.resolve(root.rootReal, directory),
        rootPath: root.rootReal,
        rootCanonicalPath: root.rootReal,
        boundaryLabel: "root walk",
      });
      if (!resolvedDirectory.exists || resolvedDirectory.kind !== "directory") {
        throw new FsSafeError(
          "not-file",
          `root walk path is not a directory: ${directory || "."}`,
        );
      }
      if (visitedDirectories.has(resolvedDirectory.canonicalPath)) {
        return;
      }
      visitedDirectories.add(resolvedDirectory.canonicalPath);

      options.signal?.throwIfAborted();

      const listingDirectory = path
        .relative(root.rootReal, resolvedDirectory.canonicalPath)
        .split(path.sep)
        .join(path.posix.sep);
      entries = await root.list(listingDirectory, { withFileTypes: true });
    } catch (error) {
      // Cancellation is never a recoverable directory read failure.
      options.signal?.throwIfAborted();
      if ((options.onDirectoryError ?? "throw") === "throw") throw error;
      yield { relativePath: directory, kind: "directory-error", size: 0, error };
      return;
    }
    options.signal?.throwIfAborted();
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const child = directory
        ? path.posix.join(directory.split(path.sep).join(path.posix.sep), entry.name)
        : entry.name;
      if (examined >= maxEntries) {
        yield onLimit(child);
        return;
      }
      examined += 1;
      let kind = entryKind(entry);
      let size = entry.size;
      if (kind === "symlink") {
        if (options.symlinkPolicy === "skip") {
          continue;
        }
        const resolved = await resolveRootPath({
          absolutePath: path.resolve(root.rootReal, child),
          rootPath: root.rootReal,
          rootCanonicalPath: root.rootReal,
          boundaryLabel: "root walk",
        });
        if (!resolved.exists) {
          continue;
        }
        kind = resolved.kind === "directory" ? "directory" : resolved.kind === "file" ? "file" : "other";
        size = entry.size;
      }

      const walkEntry: RootWalkDataEntry = { relativePath: child, kind, size };
      const filterResult = options.entryFilter?.(walkEntry) ?? "include";
      if (!(["include", "skip", "skip-subtree"] as const).includes(filterResult)) {
        throw new TypeError(`invalid root walk entryFilter result: ${String(filterResult)}`);
      }
      if (filterResult === "include") {
        yield walkEntry;
      }
      if (kind !== "directory") {
        continue;
      }
      if (filterResult === "skip-subtree") {
        continue;
      }
      if (depth >= maxDepth) {
        yield onLimit(child);
        return;
      }
      yield* visit(child, depth + 1);
    }
  }

  yield* visit(relativePath, 0);
}
