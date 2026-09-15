import type { BigIntStats } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
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
  if (options.order !== undefined && options.order !== "filesystem" && options.order !== "sorted") {
    throw new TypeError("remove order must be filesystem or sorted");
  }
  for (const key of ["maxEntries", "maxDepth"] as const) {
    const value = options[key];
    if (value !== undefined && value !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`${key} must be a non-negative safe integer`);
    }
  }
  if (!options.recursive && (options.maxEntries !== undefined || options.maxDepth !== undefined)) {
    throw new TypeError("remove budgets require recursive: true");
  }
  if (!options.recursive && options.order !== undefined) {
    throw new TypeError("remove order requires recursive: true");
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

type RemovalParentAdmission = Readonly<{
  guards: AsyncDirectoryGuard<BigIntStats>[];
  assertAfterMutation(): void;
  assertCurrent(): void;
}>;

function assertRemovalAncestorsCurrent(
  guards: readonly AsyncDirectoryGuard<BigIntStats>[],
  endExclusive = guards.length,
): void {
  for (let index = 0; index < endExclusive; index += 1) {
    const guard = guards[index]!;
    try {
      assertSyncDirectoryGuard(guard);
    } catch (error) {
      // force tolerates a vanished leaf, never a lost traversal boundary.
      throw new FsSafeError("path-mismatch", "removal ancestor changed during operation", { cause: error });
    }
  }
}

async function admitRemovalAncestors(
  root: RootContext,
  targetPath: string,
  options: RootRemoveOptions,
  rootGuard: AsyncDirectoryGuard<BigIntStats>,
): Promise<RemovalParentAdmission | undefined> {
  const parentPath = path.dirname(targetPath);
  if (!isPathInside(root.rootReal, parentPath)) {
    throw new FsSafeError("path-mismatch", "removal parent is outside the retained root");
  }

  const guards: AsyncDirectoryGuard<BigIntStats>[] = [rootGuard];
  let ancestor = root.rootReal;
  const parentRelative = path.relative(root.rootReal, parentPath);
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, segment);
    let guard: AsyncDirectoryGuard<BigIntStats>;
    try {
      guard = await createAsyncDirectoryGuard(ancestor, { bigint: true });
    } catch (error) {
      if (isNotFoundPathError(error)) {
        assertRemovalAncestorsCurrent(guards);
        assertNotAborted(options.signal);
        if (options.force) return undefined;
      }
      throw normalizeRemoveGuardError(error);
    }
    // The resolver may have returned a canonical path, but a writable ancestor
    // can be redirected before its immediate parent guard is captured. Admit
    // each component beneath the retained Root instead of trusting that guard.
    if (!isPathInside(guard.realPath, ancestor) || !isPathInside(ancestor, guard.realPath)) {
      throw new FsSafeError("path-mismatch", "removal ancestor changed during operation");
    }
    guards.push(guard);
  }

  return Object.freeze({
    guards,
    assertAfterMutation(): void {
      const immediateParentIndex = guards.length - 1;
      assertRemovalAncestorsCurrent(guards, immediateParentIndex);
      // Preserve the established nonrecursive post-dispatch mapping for the
      // immediate parent: disappearance is `not-found`, while replacements
      // retain their directory-guard classification. Earlier lost ancestry
      // remains a fail-closed `path-mismatch`.
      assertSyncDirectoryGuard(guards[immediateParentIndex]!);
    },
    assertCurrent(): void {
      assertRemovalAncestorsCurrent(guards);
    },
  });
}

async function admitRemovalParent(
  root: RootContext,
  targetPath: string,
  options: RootRemoveOptions,
): Promise<RemovalParentAdmission | undefined> {
  let rootGuard: AsyncDirectoryGuard<BigIntStats>;
  try {
    rootGuard = await createAsyncDirectoryGuard(root.rootReal, { bigint: true });
  } catch (error) {
    // force may tolerate a missing target or parent, never a missing Root.
    if (options.force && isNotFoundPathError(error)) await assertRootIdentityCurrent(root);
    throw normalizeRemoveGuardError(error);
  }
  if (!sameFileIdentityForCleanup(rootGuard.stat, root.rootIdentity)) throw rootPathChangedError();
  return await admitRemovalAncestors(root, targetPath, options, rootGuard);
}

async function removeOne(root: RootContext, targetPath: string, options: RootRemoveOptions): Promise<void> {
  const admission = await admitRemovalParent(root, targetPath, options);
  if (!admission) return;
  try {
    await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("remove", targetPath);
    admission.assertCurrent();
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
  try {
    admission.assertAfterMutation();
  } catch (error) {
    throw normalizeRemoveGuardError(error);
  }
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
  const details = (target: string, phase: "enumerate" | "inspect" | "remove") => ({
    operation: "remove",
    phase,
    relativePath: path.relative(targetPath, target),
  });
  let examined = 0;
  const rootGuard = await createAsyncDirectoryGuard(root.rootReal, { bigint: true });
  if (!sameFileIdentityForCleanup(rootGuard.stat, root.rootIdentity)) throw rootPathChangedError();
  const admission = await admitRemovalAncestors(root, targetPath, options, rootGuard);
  if (!admission) return;
  const retainedAdmission: RemovalParentAdmission = admission;
  const { guards } = retainedAdmission;

  function assertCurrent(): void {
    retainedAdmission.assertCurrent();
  }
  const inspect = (target: string, expected?: BigIntStats) => {
    assertCurrent();
    try {
      return inspectFileIdentitySync(() => fsSync.lstatSync(target, { bigint: true }), expected);
    } catch (error) {
      if (options.force && isNotFoundPathError(error)) return;
      throw normalizeRemovePathError(error, details(target, expected ? "remove" : "inspect"));
    }
  };

  async function visit(target: string, depth: number, entryCounted = false): Promise<void> {
    assertNotAborted(options.signal);
    if ((!entryCounted && examined >= maxEntries) || depth > maxDepth) {
      throw new FsSafeError("too-large", "recursive removal budget exceeded", {
        details: details(target, "inspect"),
      });
    }
    if (!entryCounted) examined += 1;
    await assertMutationNotDenied(target, options.denyMutations, { protectAncestors: true });
    assertNotAborted(options.signal);
    const initial = inspect(target);
    if (!initial) return;
    assertFinalSymlinkRejected(target, options.mutationSymlinks !== undefined, details(target, "inspect"));
    if (initial.isDirectory()) {
      let directoryGuard: AsyncDirectoryGuard<BigIntStats>;
      try {
        directoryGuard = await createAsyncDirectoryGuard(target, { bigint: true });
      } catch (error) {
        assertCurrent();
        assertNotAborted(options.signal);
        if (options.force && isNotFoundPathError(error)) return;
        throw normalizeRemovePathError(error, details(target, "inspect"));
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
          if (options.force && isNotFoundPathError(error)) {
            assertNotAborted(options.signal);
            return undefined;
          }
          throw normalizeRemovePathError(error, details(target, "enumerate"));
        });
        if (handle) {
          let failed = false;
          let operationError: unknown;
          try {
            let names: string[] | undefined = options.order === "sorted" ? [] : undefined;
            if (names && maxEntries === Infinity) {
              assertCurrent();
              assertNotAborted(options.signal);
              const snapshot = await fs.readdir(target).catch(error => {
                if (options.force && isNotFoundPathError(error)) return undefined;
                throw normalizeRemovePathError(error, details(target, "enumerate"));
              });
              assertNotAborted(options.signal);
              if (snapshot) {
                assertCurrent();
                names = snapshot;
                examined += names.length;
              }
            } else {
              while (true) {
                assertCurrent();
                assertNotAborted(options.signal);
                const entry = await handle.read().catch(error => {
                  if (options.force && isNotFoundPathError(error)) return undefined;
                  throw normalizeRemovePathError(error, details(target, "enumerate"));
                });
                if (entry === undefined) {
                  assertNotAborted(options.signal);
                  if (names) names.length = 0;
                  break;
                }
                assertCurrent();
                assertNotAborted(options.signal);
                if (!entry) break;
                if (names) {
                  if (examined >= maxEntries) {
                    throw new FsSafeError("too-large", "recursive removal budget exceeded", {
                      details: details(path.join(target, entry.name), "enumerate"),
                    });
                  }
                  examined += 1;
                  names.push(entry.name);
                } else {
                  await visit(path.join(target, entry.name), depth + 1);
                }
              }
            }
            if (names) {
              for (const name of names.sort()) {
                await visit(path.join(target, name), depth + 1, true);
              }
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
              const closeError = normalizeRemovePathError(error, details(target, "enumerate"));
              if (failed) throw createSuppressedError(closeError, operationError, "recursive removal and close both failed");
              throw closeError;
            }
          }
        }
      } finally {
        guards.pop();
      }
    }
    // A tolerated missing-directory observation still rechecks its target and ancestors.
    await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("remove", target);
    await assertMutationNotDenied(target, options.denyMutations, { protectAncestors: true });
    assertNotAborted(options.signal);
    if (!inspect(target, initial)) return;
    assertFinalSymlinkRejected(target, options.mutationSymlinks !== undefined, details(target, "remove"));
    assertNotAborted(options.signal);
    options.assertBeforeMutation?.();
    try {
      await (initial.isDirectory() ? fs.rmdir(target) : fs.unlink(target));
    } catch (error) {
      if (!(options.force && isNotFoundPathError(error))) {
        throw normalizeRemovePathError(error, details(target, "remove"));
      }
    }
    assertCurrent();
    assertNotAborted(options.signal);
  }

  await assertRootIdentityCurrent(root);
  await visit(targetPath, 0);
}
