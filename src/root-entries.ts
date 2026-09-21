import { FsSafeError } from "./errors.js";
import { validatePinnedRelativePath } from "./pinned-operation.js";
import { resolvePathInRoot, type RootContext } from "./root-context.js";
import { openRootDirectoryListing } from "./root-directory-list.js";
import { readSymlinkResolution, type SymlinkPolicy } from "./root-symlink-policy.js";
import { createSuppressedError } from "./suppressed-error.js";
import type { DirEntry } from "./types.js";

export type RootEntriesOptions = {
  maxEntries?: number;
  order?: "filesystem" | "sorted";
  signal?: AbortSignal;
  symlinks?: SymlinkPolicy;
};

export async function* entriesInRoot(
  root: RootContext,
  relativePath: string,
  options: RootEntriesOptions,
): AsyncGenerator<DirEntry> {
  const maxEntries = options.maxEntries;
  if (maxEntries !== undefined && (!Number.isSafeInteger(maxEntries) || maxEntries < 0)) {
    throw new RangeError("maxEntries must be a non-negative safe integer");
  }
  if (options.order !== undefined && options.order !== "filesystem" && options.order !== "sorted") {
    throw new TypeError(`invalid root entries order: ${String(options.order)}`);
  }
  options.signal?.throwIfAborted();
  validatePinnedRelativePath(relativePath);
  const resolved = await resolvePathInRoot(root, relativePath, {
    ...readSymlinkResolution(options.symlinks),
    resolveCanonical: true,
  });
  options.signal?.throwIfAborted();
  let examined = 0;
  const listing = await openRootDirectoryListing(root, resolved.resolved, {
    order: options.order ?? "filesystem",
    signal: options.signal,
    snapshot: false,
    maxNames: maxEntries,
    metadataBatchSize: 1,
    admitEntry: () => maxEntries === undefined || examined++ < maxEntries,
  });
  let failed = false;
  let operationError: unknown;
  try {
    while (true) {
      const next = await listing.next();
      options.signal?.throwIfAborted();
      if (next === undefined) return;
      if (next.kind === "limit") {
        throw new FsSafeError("too-large", "directory entry budget exceeded");
      }
      yield next.entry;
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
        throw createSuppressedError(closeError, operationError, "directory iteration and close both failed");
      }
      throw closeError;
    }
  }
}
