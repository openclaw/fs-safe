import path from "node:path";
import { isWindowsReservedDeviceName } from "./device-path.js";
import { isNotFoundPathError } from "./path.js";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { validatePinnedRelativePath } from "./pinned-operation.js";
import { assertRootIdentityCurrent, assertValidRootRelativePath, resolvePathInRoot, type RootContext } from "./root-context.js";
import { createRootDirectoryObservationGuard, assertRootDirectoryObservationGuard, openRootDirectoryListing, pathStatFromStats, type RootDirectoryObservationGuard } from "./root-directory-list.js";
import { createSuppressedError } from "./suppressed-error.js";
import { lookupRootDirectoryEntry } from "./root-directory-entry.js";
import type { DirEntry } from "./types.js";
import type { WatchEntry, WatchOptions, WatchScope } from "./watch-types.js";

export type DirectoryIdentity = Readonly<{ dev: bigint; ino: bigint }>;
export type WatchSnapshot = { entries: Map<string, string>; directories: Map<string, DirectoryIdentity>; targets: Map<string, DirectoryIdentity>; scanned: number; structural?: Set<string>; overflow?: boolean };
export function watchScopes(input: readonly WatchScope[]): readonly WatchScope[] {
  if (!Array.isArray(input) || input.length > 128) throw new RangeError("watch accepts at most 128 scopes");
  return Object.freeze(input.map(scope => {
    const { path: suppliedPath, kind: suppliedKind, depth: suppliedDepth } = scope;
    if (typeof suppliedPath !== "string" || path.isAbsolute(suppliedPath)) throw new FsSafeError("invalid-path", "watch scopes must be relative");
    validatePinnedRelativePath(suppliedPath);
    assertValidRootRelativePath(suppliedPath);
    if (process.platform === "win32" && suppliedPath.split(/[\\/]/).some(component => component !== "." &&
      (component.endsWith(".") || component.endsWith(" ") || isWindowsReservedDeviceName(component)))) {
      throw new FsSafeError("invalid-path", "watch scopes must use literal Windows names");
    }
    if (suppliedKind !== "entry" && suppliedKind !== "tree") throw new TypeError("invalid watch scope kind");
    const depth = suppliedDepth ?? 32;
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 128) throw new RangeError("watch depth must be between 0 and 128");
    // Normalize only admitted input, then remove the separator normalize preserves.
    const spelling = path.normalize(suppliedPath);
    const normalized = spelling.endsWith(path.sep) ? spelling.slice(0, -1) : spelling;
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
/** A descendant's unavailable metadata never grants it authority or retires the Root. */
export function isWatchPathError(error: unknown): boolean {
  if (isNotFoundPathError(error)) return true;
  if (error instanceof FsSafeError) {
    if (error.details?.operation === "watch" && ["EACCES", "EPERM", "EBUSY"].includes(String(error.details.code))) return true;
    return ["not-found", "path-mismatch", "not-file", "symlink", "outside-workspace", "path-alias"].includes(error.code);
  }
  return ["ENOTDIR", "EACCES", "EPERM", "EBUSY", "ESTALE", "EIO", "ELOOP"].includes((error as { code?: string } | null)?.code ?? "");
}
export async function scanWatch(
  root: RootContext,
  scopes: readonly WatchScope[],
  options: Pick<WatchOptions, "exclude"> & { maxEntries: number; maxDirectories: number; maxPendingPaths: number; admitting: boolean },
  signal: AbortSignal,
  register: (name: string, identity: DirectoryIdentity, guard: RootDirectoryObservationGuard) => Promise<void>,
  onCleanupFailure?: (error: unknown) => void,
): Promise<WatchSnapshot> {
  const result: WatchSnapshot = { entries: new Map(), directories: new Map(), targets: new Map(), scanned: 0 };
  const attempts = new Map<string, number>();
  const guards = new Map<string, RootDirectoryObservationGuard>();
  const walked = new Map<string, number>();
  const structural = new Set<string>();
  result.structural = structural;
  const invalidate = (relative: string) => {
    if (structural.size < options.maxPendingPaths) structural.add(relative); else result.overflow = true;
    // Discard partially observed names when their enclosing directory lost admission.
    const below = (name: string) => name === relative || !relative || name.startsWith(relative + path.sep);
    for (const map of [result.entries, result.targets, result.directories, guards, walked]) {
      for (const name of map.keys()) if (below(name)) map.delete(name);
    }
  };
  const recover = async (relative: string, error: unknown) => {
    signal.throwIfAborted();
    await assertRootIdentityCurrent(root);
    const code = error instanceof FsSafeError ? error.details?.code ?? error.code : (error as { code?: string } | null)?.code;
    if (!isWatchPathError(error) || (!relative && (code === "EACCES" || code === "EPERM"))) throw error;
    invalidate(relative);
  };
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
    if (prior) {
      try { await assertRootDirectoryObservationGuard(root, prior); return prior; }
      catch (error) { await recover(relative, error); }
    }
    if (!attempts.has(relative) && attempts.size >= options.maxDirectories) {
      throw new FsSafeError("too-large", "watch directory budget exceeded", { details: { operation: "scan" } });
    }
    let registrationError: unknown;
    while ((attempts.get(relative) ?? 0) < 3) {
      attempts.set(relative, (attempts.get(relative) ?? 0) + 1);
      try {
        const resolved = await resolvePathInRoot(root, relative ? "./" + relative : ".", { rejectSymlinks: true });
        const guard = await createRootDirectoryObservationGuard(root, resolved.resolved);
        const identity = { dev: guard.stat.dev, ino: guard.stat.ino };
        result.directories.set(relative, identity);
        await register(relative, identity, guard);
        signal.throwIfAborted();
        await assertRootDirectoryObservationGuard(root, guard);
        guards.set(relative, guard);
        return guard;
      } catch (error) { registrationError = error; await recover(relative, error); }
    }
    if (!relative) throw new FsSafeError("helper-failed", "watch Root registration could not be established", {
      cause: registrationError, details: { operation: "watch", code: "registration-failed" },
    });
    throw new FsSafeError("path-mismatch", "watch directory changed during registration");
  };
  const tree = async (relative: string, depth: number): Promise<void> => {
    if ((walked.get(relative) ?? 0) >= depth) return;
    walked.set(relative, depth);
    let guard!: RootDirectoryObservationGuard;
    let listing: Awaited<ReturnType<typeof openRootDirectoryListing>> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        guard = await directory(relative);
        listing = await openRootDirectoryListing(root, guard.realPath, {
          order: "filesystem", snapshot: false, signal, exactIdentity: true, onCleanupFailure, admitEntry: () => { examined(); return true; },
        });
        // The listing has its own guard. Both identities must agree before reading names.
        await assertRootDirectoryObservationGuard(root, guard);
        break;
      } catch (error) {
        await listing?.[Symbol.asyncDispose](); listing = undefined;
        await recover(relative, error);
      }
    }
    if (!listing) return;
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
    } catch (error) { failed = true; operationError = error; await recover(relative, error); }
    finally {
      try { await listing[Symbol.asyncDispose](); }
      catch (closeError) {
        if (failed) throw createSuppressedError(closeError, operationError, "watch scan and directory disposal both failed");
        throw closeError;
      }
    }
    try { await assertRootDirectoryObservationGuard(root, guard); }
    catch (error) { await recover(relative, error); }
  };
  await assertRootIdentityCurrent(root);
  for (const scope of scopes) {
    signal.throwIfAborted();
    if (!scope.path) {
      const guard = await directory("");
      result.entries.set("", fingerprint({ name: "", ...pathStatFromStats(guard.stat) }, guard.stat));
      if (scope.kind === "tree" && scope.depth! > 0) await tree("", scope.depth!);
      continue;
    }
    const segments = scope.path.split(path.sep);
    let relative = "";
    try {
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
        if (found.entry.isSymbolicLink) {
          if (options.admitting) throw new FsSafeError("symlink", "watch scope traverses a symbolic link; admit its target separately", { details: { operation: "scope" } });
          invalidate(name); break;
        }
        if (!found.entry.isDirectory) break;
        relative = name;
      }
    } catch (error) {
      if (error instanceof FsSafeError && error.details?.operation === "scope") throw error;
      await recover(relative, error);
    }
  }
  for (const [relative, guard] of guards) {
    try { await assertRootDirectoryObservationGuard(root, guard); }
    catch (error) { await recover(relative, error); }
  }
  await assertRootIdentityCurrent(root);
  signal.throwIfAborted();
  return result;
}
