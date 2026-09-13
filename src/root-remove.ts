import type { BigIntStats } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertAsyncDirectoryGuard,
  assertSyncDirectoryGuard,
  createAsyncDirectoryGuard,
  type AsyncDirectoryGuard,
} from "./directory-guard.js";
import { assertMutationNotDenied } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { MutationAuthorityError } from "./mutation-authority.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { assertRootIdentityCurrent, type RootContext } from "./root-context.js";
import { normalizeRemoveGuardError, normalizeRemovePathError, rootPathChangedError } from "./root-errors.js";
import type { RootRemoveOptions } from "./root-options.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_DEPTH = 64;

export function validateRemoveOptions(options: RootRemoveOptions): void {
  for (const key of ["maxEntries", "maxDepth"] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`${key} must be a non-negative safe integer`);
    }
  }
  if (!options.recursive && (options.maxEntries !== undefined || options.maxDepth !== undefined)) {
    throw new TypeError("remove budgets require recursive: true");
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  try {
    signal?.throwIfAborted();
  } catch (error) {
    // Preserve arbitrary abort reasons through Root's filesystem error mapping.
    throw new MutationAuthorityError(error);
  }
}

async function removeOne(root: RootContext, targetPath: string, options: RootRemoveOptions): Promise<void> {
  let guard;
  try {
    guard = await createAsyncDirectoryGuard(path.dirname(targetPath));
  } catch (error) {
    if (options.force && isNotFoundPathError(error)) {
      await assertRootIdentityCurrent(root);
      assertNotAborted(options.signal);
      return;
    }
    throw normalizeRemoveGuardError(error);
  }
  try {
    await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("remove", targetPath);
    await assertAsyncDirectoryGuard(guard);
  } catch (error) {
    throw normalizeRemoveGuardError(error);
  }
  try {
    const isDirectory = fsSync.lstatSync(targetPath).isDirectory();
    assertFinalSymlinkRejected(targetPath, options.mutationSymlinks !== undefined);
    assertNotAborted(options.signal);
    options.assertBeforeMutation?.();
    await (isDirectory ? fs.rmdir(targetPath) : fs.unlink(targetPath));
  } catch (error) {
    if (!(options.force && isNotFoundPathError(error))) throw normalizeRemovePathError(error);
  }
  await assertAsyncDirectoryGuard(guard).catch(error => { throw normalizeRemoveGuardError(error); });
  assertNotAborted(options.signal);
}

export async function removePathInRootFallback(
  root: RootContext,
  targetPath: string,
  options: RootRemoveOptions,
): Promise<void> {
  assertNotAborted(options.signal);
  if (!options.recursive) {
    await removeOne(root, targetPath, options);
    return;
  }

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  let examined = 0;
  const rootGuard = await createAsyncDirectoryGuard(root.rootReal, { bigint: true });
  if (!sameFileIdentityForCleanup(rootGuard.stat, root.rootIdentity)) throw rootPathChangedError();
  const guards: AsyncDirectoryGuard<BigIntStats>[] = [rootGuard];
  let ancestor = root.rootReal;
  const parentRelative = path.relative(root.rootReal, path.dirname(targetPath));
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, segment);
    let guard: AsyncDirectoryGuard<BigIntStats>;
    try {
      guard = await createAsyncDirectoryGuard(ancestor, { bigint: true });
    } catch (error) {
      if (isNotFoundPathError(error)) {
        assertCurrent();
        assertNotAborted(options.signal);
        if (options.force) return;
      }
      throw normalizeRemoveGuardError(error);
    }
    if (!isPathInside(guard.realPath, ancestor) || !isPathInside(ancestor, guard.realPath)) {
      throw new FsSafeError("path-mismatch", "removal ancestor changed during operation");
    }
    guards.push(guard);
  }

  function assertCurrent(): void {
    for (const guard of guards) {
      try {
        assertSyncDirectoryGuard(guard);
      } catch (error) {
        // force tolerates a vanished leaf, never a lost traversal boundary.
        throw new FsSafeError("path-mismatch", "removal ancestor changed during operation", { cause: error });
      }
    }
  }
  const inspect = (target: string, expected?: BigIntStats) => {
    assertCurrent();
    try {
      return inspectFileIdentitySync(() => fsSync.lstatSync(target, { bigint: true }), expected);
    } catch (error) {
      if (options.force && isNotFoundPathError(error)) return;
      throw normalizeRemovePathError(error);
    }
  };

  async function visit(target: string, depth: number): Promise<void> {
    assertNotAborted(options.signal);
    if (examined >= maxEntries || depth > maxDepth) {
      throw new FsSafeError("too-large", "recursive removal budget exceeded");
    }
    examined += 1;
    await assertMutationNotDenied(target, options.denyMutations, { protectAncestors: true });
    assertNotAborted(options.signal);
    const initial = inspect(target);
    if (!initial) return;
    assertFinalSymlinkRejected(target, options.mutationSymlinks !== undefined);
    if (initial.isDirectory()) {
      let directoryGuard: AsyncDirectoryGuard<BigIntStats>;
      try {
        directoryGuard = await createAsyncDirectoryGuard(target, { bigint: true });
      } catch (error) {
        assertCurrent();
        assertNotAborted(options.signal);
        if (options.force && isNotFoundPathError(error)) return;
        throw normalizeRemovePathError(error);
      }
      if (!isPathInside(directoryGuard.realPath, target) || !isPathInside(target, directoryGuard.realPath) ||
        !sameFileIdentityForCleanup(directoryGuard.stat, initial)) {
        throw new FsSafeError("path-mismatch", "removal directory changed during operation");
      }
      guards.push(directoryGuard);
      try {
        assertCurrent();
        assertNotAborted(options.signal);
        const handle = await fs.opendir(target, { bufferSize: 1 }).catch(error => {
          throw normalizeRemovePathError(error);
        });
        let failed = false;
        let operationError: unknown;
        try {
          while (true) {
            assertCurrent();
            assertNotAborted(options.signal);
            const entry = await handle.read().catch(error => { throw normalizeRemovePathError(error); });
            assertCurrent();
            assertNotAborted(options.signal);
            if (!entry) break;
            await visit(path.join(target, entry.name), depth + 1);
          }
        } catch (error) {
          failed = true;
          operationError = error instanceof MutationAuthorityError ? error.rejection : error;
          throw error;
        } finally {
          try {
            // Close before rmdir, including on Windows and after revocation.
            await handle.close();
          } catch (error) {
            const closeError = normalizeRemovePathError(error);
            if (failed) throw createSuppressedError(closeError, operationError, "recursive removal and close both failed");
            throw closeError;
          }
        }
      } finally {
        guards.pop();
      }
    }
    await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("remove", target);
    await assertMutationNotDenied(target, options.denyMutations, { protectAncestors: true });
    assertNotAborted(options.signal);
    if (!inspect(target, initial)) return;
    assertFinalSymlinkRejected(target, options.mutationSymlinks !== undefined);
    assertNotAborted(options.signal);
    options.assertBeforeMutation?.();
    try {
      await (initial.isDirectory() ? fs.rmdir(target) : fs.unlink(target));
    } catch (error) {
      if (!(options.force && isNotFoundPathError(error))) throw normalizeRemovePathError(error);
    }
    assertCurrent();
    assertNotAborted(options.signal);
  }

  await assertRootIdentityCurrent(root);
  await visit(targetPath, 0);
}
