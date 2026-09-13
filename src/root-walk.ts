import path from "node:path";
import { FsSafeError } from "./errors.js";
import { resolveRootPath } from "./root-path.js";
import type { RootDirectoryListing, RootDirectoryListingOptions } from "./root-directory-list.js";
import type { DirEntry, PathStat } from "./types.js";
import { createSuppressedError } from "./suppressed-error.js";

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
  order?: "sorted" | "filesystem";
  symlinkPolicy: RootWalkSymlinkPolicy;
  signal?: AbortSignal;
  limitBehavior?: RootWalkLimitBehavior;
  entryFilter?: RootWalkEntryFilter;
  onDirectoryError?: RootWalkDirectoryErrorBehavior;
};

type RootWalkCapability = {
  rootReal: string;
  stat(relativePath: string): Promise<PathStat>;
  list(
    relativePath: string,
    options: RootDirectoryListingOptions,
  ): Promise<RootDirectoryListing>;
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
  if (options.order !== undefined && !(["sorted", "filesystem"] as const).includes(options.order)) {
    throw new TypeError(`invalid root walk order: ${String(options.order)}`);
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
  let truncated = false;

  const admitEntry = () => {
    if (examined >= maxEntries) return false;
    examined += 1;
    return true;
  };

  const onLimit = (atPath: string): RootWalkEntry => {
    if ((options.limitBehavior ?? "truncate") === "throw") {
      throw new FsSafeError("too-large", `root walk budget exceeded at ${atPath || "."}`);
    }
    truncated = true;
    return limitEntry(atPath);
  };

  const onDirectoryError = (directory: string, error: unknown): RootWalkEntry => {
    // Rethrow cancellation with any disposal failure already attached.
    if (options.signal?.aborted || (options.onDirectoryError ?? "throw") === "throw") throw error;
    return { relativePath: directory, kind: "directory-error", size: 0, error };
  };

  async function* visit(directory: string, depth: number): AsyncGenerator<RootWalkEntry> {
    options.signal?.throwIfAborted();
    let listing: RootDirectoryListing;
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
      listing = await root.list(listingDirectory, {
        order: options.order ?? "sorted",
        signal: options.signal,
        snapshot: maxEntries === Number.POSITIVE_INFINITY,
        admitEntry,
      });
    } catch (error) {
      yield onDirectoryError(directory, error);
      return;
    }
    // A thrown undefined still needs to be retained if closing also fails.
    let failed = false;
    let operationError: unknown;
    try {
      while (true) {
        let next: Awaited<ReturnType<RootDirectoryListing["next"]>>;
        try {
          next = await listing.next();
          options.signal?.throwIfAborted();
        } catch (error) {
          yield onDirectoryError(directory, error);
          return;
        }
        if (next === undefined) return;
        const name = next.kind === "entry" ? next.entry.name : next.name;
        const child = directory
          ? path.posix.join(directory.split(path.sep).join(path.posix.sep), name)
          : name;
        if (next.kind === "limit") {
          yield onLimit(child);
          return;
        }
        const entry = next.entry;
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
          const target = await root.stat(path.relative(root.rootReal, resolved.canonicalPath));
          kind = target.isDirectory ? "directory" : target.isFile ? "file" : "other";
          size = target.size;
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
        if (truncated) return;
      }
    } catch (error) {
      failed = true;
      operationError = error;
      throw error;
    } finally {
      try {
        await listing[Symbol.asyncDispose]();
      } catch (closeError) {
        if (failed) {
          throw createSuppressedError(closeError, operationError, "directory walk and close both failed");
        }
        throw closeError;
      }
    }
  }

  yield* visit(relativePath, 0);
}
