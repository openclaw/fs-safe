import type { BigIntStats } from "node:fs";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertSyncDirectoryGuard,
  createAsyncDirectoryGuard,
  inspectDirectoryIdentitySync,
  type AsyncDirectoryGuard,
} from "./directory-guard.js";
import { assertMutationNotDenied } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { MutationAuthorityError } from "./mutation-authority.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { assertRootIdentityCurrent, type RootContext } from "./root-context.js";
import { errorCauseOptions, normalizeRemoveGuardError, normalizeRemovePathError, rootPathChangedError } from "./root-errors.js";
import type { RootRemoveOptions } from "./root-options.js";
import {
  assertRemovalDirectoryCurrent,
  createRemovalDirectoryAssertion,
  type RemovalDirectoryAssertion,
} from "./root-remove-identity.js";
import type { RemovalPathReceipts } from "./root-remove-receipt.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_DEPTH = 64;

export const nonrecursiveRemovalKind: unique symbol = Symbol("nonrecursive removal kind");
type InternalRemoveOptions = RootRemoveOptions & {
  [nonrecursiveRemovalKind]?: "directory";
};

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

type RemovalDirectoryReceipt = RemovalDirectoryAssertion;

type NonrecursiveRemovalAdmission = Readonly<{
  assertAfterMutation(): void;
  assertCurrent(): void;
}>;

function removalAncestorChanged(error?: unknown): FsSafeError {
  return new FsSafeError("path-mismatch", "removal ancestor changed during operation", errorCauseOptions(error));
}

function sameCanonicalDirectory(left: string, right: string): boolean {
  return left === right || (isPathInside(left, right) && isPathInside(right, left));
}

function assertExactRemovalReceiptPrefixCurrent(
  rootGuard: AsyncDirectoryGuard<BigIntStats>,
  intermediates: readonly RemovalDirectoryReceipt[],
): void {
  try {
    assertSyncDirectoryGuard(rootGuard);
    for (const receipt of intermediates) {
      inspectDirectoryIdentitySync(receipt.path, receipt);
    }
  } catch (error) {
    // force tolerates a vanished leaf, never a lost traversal boundary.
    throw removalAncestorChanged(error);
  }
}

async function assertMissingRemovalPrefixCurrent(
  rootGuard: AsyncDirectoryGuard<BigIntStats>,
  intermediates: readonly RemovalDirectoryReceipt[],
): Promise<void> {
  if (intermediates.length === 0) {
    assertExactRemovalReceiptPrefixCurrent(rootGuard, intermediates);
    return;
  }

  const deepest = intermediates[intermediates.length - 1]!;
  assertExactRemovalReceiptPrefixCurrent(rootGuard, intermediates.slice(0, -1));
  let deepestGuard: AsyncDirectoryGuard<BigIntStats>;
  try {
    deepestGuard = await createAsyncDirectoryGuard(deepest.path, { bigint: true });
  } catch (error) {
    throw removalAncestorChanged(error);
  }
  if (!sameFileIdentityForCleanup(deepestGuard.stat, deepest) ||
    !sameCanonicalDirectory(deepestGuard.realPath, deepest.path)) {
    throw removalAncestorChanged();
  }
}

async function captureNonrecursiveRemovalAdmission(
  root: RootContext,
  targetPath: string,
  options: RootRemoveOptions,
  receipts?: RemovalPathReceipts,
): Promise<NonrecursiveRemovalAdmission | undefined> {
  const parentPath = path.dirname(targetPath);
  if (!isPathInside(root.rootReal, parentPath)) {
    throw new FsSafeError("path-mismatch", "removal parent is outside the retained root");
  }

  const retained = receipts?.complete(root.rootReal, targetPath);
  let rootGuard: AsyncDirectoryGuard<BigIntStats>;
  try {
    // A complete, exactly spelled parent canonicalization below also proves
    // Root's canonical route. Retain Root's earlier exact identity either way.
    rootGuard = retained && parentPath !== root.rootReal
      ? { dir: root.rootReal, realPath: root.rootReal, stat: retained.rootStat }
      : await createAsyncDirectoryGuard(root.rootReal, { bigint: true, initial: retained?.rootStat });
  } catch (error) {
    // force may tolerate a missing target or parent, never a missing Root.
    if (options.force && isNotFoundPathError(error)) await assertRootIdentityCurrent(root);
    throw normalizeRemoveGuardError(error);
  }
  if (!sameFileIdentityForCleanup(rootGuard.stat, root.rootIdentity)) throw rootPathChangedError();

  if (parentPath === root.rootReal) {
    const rootAssertion = createRemovalDirectoryAssertion(
      rootGuard.dir,
      rootGuard.stat,
      rootGuard.realPath,
    );
    return Object.freeze({
      assertAfterMutation(): void {
        // Here Root is also the immediate parent, so retain its established
        // post-dispatch error classification while checking it only once.
        assertRemovalDirectoryCurrent(rootAssertion);
      },
      assertCurrent(): void {
        try {
          assertRemovalDirectoryCurrent(rootAssertion);
        } catch (error) {
          throw removalAncestorChanged(error);
        }
      },
    });
  }

  const intermediates: RemovalDirectoryReceipt[] = [];
  const retainedDirectories = retained?.directories;
  const freshSegments = retainedDirectories
    ? undefined
    : path.relative(root.rootReal, parentPath).split(path.sep).filter(Boolean).slice(0, -1);
  const intermediateCount = retainedDirectories ? Math.max(0, retainedDirectories.length - 1) : freshSegments!.length;
  let freshAncestor = root.rootReal;
  for (let index = 0; index < intermediateCount; index += 1) {
    const retainedDirectory = retainedDirectories?.[index];
    const ancestor = retainedDirectory?.path ?? (freshAncestor = path.join(freshAncestor, freshSegments![index]!));
    try {
      const stat = inspectDirectoryIdentitySync(ancestor, undefined, retainedDirectory?.stat);
      intermediates.push(createRemovalDirectoryAssertion(ancestor, stat));
    } catch (error) {
      if (isNotFoundPathError(error)) {
        await assertMissingRemovalPrefixCurrent(rootGuard, intermediates);
        assertNotAborted(options.signal);
        if (options.force) return undefined;
      }
      throw normalizeRemoveGuardError(error);
    }
  }

  let parentGuard: AsyncDirectoryGuard<BigIntStats>;
  try {
    parentGuard = await createAsyncDirectoryGuard(retained?.parent?.path ?? parentPath, {
      bigint: true,
      initial: retained?.parent?.stat,
    });
  } catch (error) {
    if (isNotFoundPathError(error)) {
      await assertMissingRemovalPrefixCurrent(rootGuard, intermediates);
      assertNotAborted(options.signal);
      if (options.force) return undefined;
    }
    throw normalizeRemoveGuardError(error);
  }
  if (!sameCanonicalDirectory(parentGuard.realPath, parentPath)) {
    throw removalAncestorChanged();
  }
  const canonicalParentCoversRoot = retained !== undefined && parentGuard.realPath === parentPath;
  if (retained && !canonicalParentCoversRoot) {
    try {
      rootGuard = await createAsyncDirectoryGuard(root.rootReal, { bigint: true, initial: retained.rootStat });
    } catch (error) {
      if (options.force && isNotFoundPathError(error)) await assertRootIdentityCurrent(root);
      throw normalizeRemoveGuardError(error);
    }
  }

  const rootAssertion = createRemovalDirectoryAssertion(
    rootGuard.dir,
    rootGuard.stat,
    canonicalParentCoversRoot ? undefined : rootGuard.realPath,
  );
  const parentAssertion = createRemovalDirectoryAssertion(
    parentGuard.dir,
    parentGuard.stat,
    parentGuard.realPath,
  );

  const assertPrefixCurrent = (): void => {
    try {
      assertRemovalDirectoryCurrent(rootAssertion);
      for (const assertion of intermediates) assertRemovalDirectoryCurrent(assertion);
    } catch (error) {
      throw removalAncestorChanged(error);
    }
  };

  return Object.freeze({
    assertAfterMutation(): void {
      assertPrefixCurrent();
      // Preserve the established nonrecursive post-dispatch mapping for the
      // immediate parent: disappearance is `not-found`, while replacements
      // retain their directory-guard classification. Earlier lost ancestry
      // remains a fail-closed `path-mismatch`.
      assertRemovalDirectoryCurrent(parentAssertion);
    },
    assertCurrent(): void {
      assertPrefixCurrent();
      try {
        assertRemovalDirectoryCurrent(parentAssertion);
      } catch (error) {
        throw removalAncestorChanged(error);
      }
    },
  });
}

async function removeOne(root: RootContext, targetPath: string, options: InternalRemoveOptions, receipts?: RemovalPathReceipts): Promise<void> {
  const admission = await captureNonrecursiveRemovalAdmission(root, targetPath, options, receipts);
  if (!admission) return;
  try {
    await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("remove", targetPath);
    admission.assertCurrent();
  } catch (error) {
    throw normalizeRemoveGuardError(error);
  }
  try {
    const identity = options.assertBeforeMutation
      ? inspectFileIdentitySync(() => fsSync.lstatSync(targetPath, { bigint: true })) : undefined;
    const isDirectory = (identity ?? fsSync.lstatSync(targetPath)).isDirectory();
    if (!isDirectory && options[nonrecursiveRemovalKind] === "directory") {
      throw new FsSafeError("path-mismatch", "store entry is no longer a directory");
    }
    assertFinalSymlinkRejected(targetPath, options.mutationSymlinks !== undefined);
    assertNotAborted(options.signal);
    options.assertBeforeMutation?.();
    if (identity) {
      assertNotAborted(options.signal);
      admission.assertCurrent();
      inspectFileIdentitySync(() => fsSync.lstatSync(targetPath, { bigint: true }), identity);
      assertFinalSymlinkRejected(targetPath, options.mutationSymlinks !== undefined);
    }
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
  receipts?: RemovalPathReceipts,
): Promise<void> {
  assertNotAborted(options.signal);
  if (!options.recursive) {
    await removeOne(root, targetPath, options, receipts);
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
    if (options.assertBeforeMutation) {
      assertNotAborted(options.signal);
      if (!inspect(target, initial)) return;
      assertFinalSymlinkRejected(target, options.mutationSymlinks !== undefined, details(target, "remove"));
    }
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
