import path from "node:path";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { validatePinnedRelativePath } from "./pinned-operation.js";
import { assertRootIdentityCurrent, assertValidRootRelativePath, resolvePathInRoot, type RootContext } from "./root-context.js";
import { createRootDirectoryObservationGuard, assertRootDirectoryObservationGuard, openRootDirectoryListing, type RootDirectoryObservationGuard } from "./root-directory-list.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { createSuppressedError } from "./suppressed-error.js";
import { lookupRootDirectoryEntry } from "./root-directory-entry.js";
import type { DirEntry } from "./types.js";
import type { WatchEntry, WatchOptions, WatchScope } from "./watch-types.js";

export type DirectoryIdentity = Readonly<{ dev: bigint; ino: bigint }>;
export type WatchSnapshot = { entries: Map<string, string>; directories: Map<string, DirectoryIdentity>; targets: Map<string, DirectoryIdentity>; scanned: number };
export function watchScopes(input: readonly WatchScope[]): readonly WatchScope[] {
  if (!Array.isArray(input) || input.length > 128) throw new RangeError("watch accepts at most 128 scopes");
  return Object.freeze(input.map(scope => {
    const { path: suppliedPath, kind: suppliedKind, depth: suppliedDepth } = scope;
    if (typeof suppliedPath !== "string" || path.isAbsolute(suppliedPath)) throw new FsSafeError("invalid-path", "watch scopes must be relative");
    validatePinnedRelativePath(suppliedPath);
    assertValidRootRelativePath(suppliedPath);
    if (suppliedKind !== "entry" && suppliedKind !== "tree") throw new TypeError("invalid watch scope kind");
    const depth = suppliedDepth ?? 32;
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 128) throw new RangeError("watch depth must be between 0 and 128");
    const normalized = path.normalize(suppliedPath);
    return Object.freeze({ path: normalized === "." ? "" : normalized, kind: suppliedKind, depth });
  }));
}

function kind(entry: DirEntry): WatchEntry["kind"] {
  return entry.isSymbolicLink ? "symlink" : entry.isDirectory ? "directory" : entry.isFile ? "file" : "other";
}
function fingerprint(entry: DirEntry, identity: DirectoryIdentity): string {
  const { dev, ino } = identity;
  // Metadata is advisory; identity bits are never rounded through PathStat. Directory size/mtime
  // reflect children, not changes to an entry-only scope.
  return entry.isDirectory
    ? [kind(entry), dev, ino, entry.mode].join(":")
    : [kind(entry), dev, ino, entry.size, entry.mtimeMs, entry.mode].join(":");
}
export function sameEntries(left: WatchSnapshot | undefined, right: WatchSnapshot): boolean {
  return !!left && left.entries.size === right.entries.size &&
    [...right.entries].every(([name, value]) => left.entries.get(name) === value);
}
export async function scanWatch(
  root: RootContext,
  scopes: readonly WatchScope[],
  options: Pick<WatchOptions, "exclude"> & { maxEntries: number; maxDirectories: number },
  signal: AbortSignal,
  register: (name: string, identity: DirectoryIdentity) => Promise<void>,
  onCleanupFailure?: (error: unknown) => void,
): Promise<WatchSnapshot> {
  const result: WatchSnapshot = { entries: new Map(), directories: new Map(), targets: new Map(), scanned: 0 };
  const guards = new Map<string, RootDirectoryObservationGuard>();
  const walked = new Map<string, number>();
  const examined = () => {
    if (++result.scanned > options.maxEntries) throw new FsSafeError("too-large", "watch entry budget exceeded", { details: { operation: "scan" } });
  };
  const excluded = (name: string, entry: DirEntry) => {
    let value: boolean | undefined;
    try {
      value = options.exclude?.({ path: name, kind: kind(entry) });
      assertSynchronousCallbackResult(value, "watch exclude");
    } catch (cause) {
      throw new FsSafeError("helper-failed", "watch exclusion callback failed", { cause, details: { operation: "callback" } });
    }
    signal.throwIfAborted();
    return value;
  };
  const directory = async (relative: string): Promise<RootDirectoryObservationGuard> => {
    signal.throwIfAborted();
    const prior = guards.get(relative);
    if (prior) { await assertRootDirectoryObservationGuard(root, prior); return prior; }
    const resolved = await resolvePathInRoot(root, relative ? "./" + relative : ".", { rejectSymlinks: true });
    const guard = await createRootDirectoryObservationGuard(root, resolved.resolved);
    if (guards.size >= options.maxDirectories) throw new FsSafeError("too-large", "watch directory budget exceeded", { details: { operation: "watch" } });
    const identity = { dev: guard.stat.dev, ino: guard.stat.ino };
    result.directories.set(relative, identity);
    guards.set(relative, guard);
    await getFsSafeTestHooks()?.beforeWatchRegistration?.(guard.realPath);
    signal.throwIfAborted();
    await register(relative, identity);
    await getFsSafeTestHooks()?.afterWatchRegistration?.(guard.realPath);
    signal.throwIfAborted();
    await assertRootDirectoryObservationGuard(root, guard);
    return guard;
  };
  const tree = async (relative: string, depth: number): Promise<void> => {
    if ((walked.get(relative) ?? 0) >= depth) return;
    walked.set(relative, depth);
    const guard = await directory(relative);
    const listing = await openRootDirectoryListing(root, guard.realPath, {
      order: "filesystem", snapshot: false, signal, exactIdentity: true, onCleanupFailure, admitEntry: () => { examined(); return true; },
    });
    let failed = false;
    let operationError: unknown;
    try {
      while (true) {
        const next = await listing.next();
        signal.throwIfAborted();
        if (!next) break;
        if (next.kind === "limit") throw new FsSafeError("too-large", "watch entry budget exceeded");
        if (!next.identity) throw new FsSafeError("path-mismatch", "watch listing lacks exact identity");
        const entry = next.entry;
        const name = relative ? path.join(relative, entry.name) : entry.name;
        if (excluded(name, entry)) continue;
        result.entries.set(name, fingerprint(entry, next.identity));
        if (entry.isDirectory && !entry.isSymbolicLink && depth > 1) await tree(name, depth - 1);
      }
      await listing.assertCurrent();
    } catch (error) { failed = true; operationError = error; throw error; }
    finally {
      try { await listing[Symbol.asyncDispose](); }
      catch (closeError) {
        if (failed) throw createSuppressedError(closeError, operationError, "watch scan and directory disposal both failed");
        throw closeError;
      }
    }
    await assertRootDirectoryObservationGuard(root, guard);
  };
  await assertRootIdentityCurrent(root);
  for (const scope of scopes) {
    signal.throwIfAborted();
    if (!scope.path) {
      await directory("");
      if (scope.kind === "tree" && scope.depth! > 0) await tree("", scope.depth!);
      continue;
    }
    const segments = scope.path.split(path.sep);
    let relative = "";
    for (let i = 0; i < segments.length; i++) {
      const guard = await directory(relative);
      examined();
      // Filesystem lookup, not lowercase/prefix matching, owns case, Unicode and
      // short-name aliases. It also preserves case-sensitive Windows directories.
      const found = await lookupRootDirectoryEntry(root, guard, segments[i]!);
      signal.throwIfAborted();
      if (!found) break;
      const name = relative ? path.join(relative, segments[i]!) : segments[i]!;
      if (excluded(name, found.entry)) break;
      if (i === segments.length - 1) {
        result.entries.set(name, fingerprint(found.entry, found.identity));
        result.targets.set(name, found.identity);
        if (scope.kind === "tree" && found.entry.isDirectory && !found.entry.isSymbolicLink && scope.depth! > 0) await tree(name, scope.depth!);
        break;
      }
      if (found.entry.isSymbolicLink) throw new FsSafeError("symlink", "watch scope traverses a symbolic link; admit its target separately");
      if (!found.entry.isDirectory) break;
      relative = name;
    }
  }
  for (const guard of guards.values()) await assertRootDirectoryObservationGuard(root, guard);
  await assertRootIdentityCurrent(root);
  signal.throwIfAborted();
  return result;
}
