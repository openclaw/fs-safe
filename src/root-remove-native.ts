import fs from "node:fs";
import path from "node:path";
import { scheduler } from "node:timers/promises";
import { assertSyncDirectoryGuard, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { assertMutationNotDenied } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { MutationAuthorityError } from "./mutation-authority.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import type { NativeRootRemovalEntry } from "./native-binding.js";
import { openNativeParentAdmission, openNativeRootAdmission, type NativeParentAdmission } from "./native-parent-admission.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { assertRootIdentityCurrentSync, type RootContext } from "./root-context.js";
import { normalizeRemoveGuardError, normalizeRemovePathError } from "./root-errors.js";
import { captureNonrecursiveRemovalAdmission, nonrecursiveRemovalKind, type InternalRemoveOptions } from "./root-remove.js";
import type { RemovalPathReceipts } from "./root-remove-receipt.js";
import { createSuppressedError } from "./suppressed-error.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

function unavailable(): false {
  if (getFsSafeNativeConfig().mode === "require") {
    throw new FsSafeError("helper-unavailable", "native confined removal is unavailable on this platform");
  }
  return false;
}

function normalize(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "path-mismatch") return new FsSafeError("path-mismatch", "removal identity changed", { cause: error });
  if (["ENOTSUP", "ENOSYS", "EOPNOTSUPP"].includes(code ?? "")) {
    return new FsSafeError("helper-unavailable", "native confined removal is unavailable", { cause: error });
  }
  return normalizeRemovePathError(error);
}

export async function tryRemovePathInRootNative(
  root: RootContext, target: string, options: InternalRemoveOptions, receipts?: RemovalPathReceipts,
): Promise<boolean> {
  const binding = getNativeBinding();
  if (!binding?.rootRemovalStat || !binding.rootRemovalUnlink || !binding.openRootRemovalDirectory) {
    return unavailable();
  }
  const inspect = binding.rootRemovalStat.bind(binding);
  const unlink = binding.rootRemovalUnlink.bind(binding);
  const openDirectory = binding.openRootRemovalDirectory.bind(binding);
  const boundary = await captureNonrecursiveRemovalAdmission(root, target, options, receipts);
  if (!boundary) return true;
  const rootAdmission = await openNativeRootAdmission(binding, {
    rootPath: root.rootReal, rootIdentity: root.rootIdentity, operation: "remove", reportCloseErrors: true,
  });
  let parent: NativeParentAdmission | undefined;
  let operationError: unknown;
  let failed = false;
  let handled = true;
  try {
    const parentPath = path.dirname(target);
    if (!isPathInside(root.rootReal, parentPath)) throw new FsSafeError("outside-workspace", "removal parent is outside root");
    try {
      parent = await openNativeParentAdmission(binding, rootAdmission,
        path.relative(root.rootReal, parentPath).split(path.sep).join("/"));
    } catch (error) {
      assertRootIdentityCurrentSync(root);
      boundary.assertCurrent();
      if (!(options.force && isNotFoundPathError(error))) throw error;
    }
    if (parent) {
      // A newly followed in-root alias must not inherit approval for the old route.
      if (path.relative(parentPath, parent.guard.realPath) !== "") {
        throw new FsSafeError("path-mismatch", "removal parent route changed");
      }
      if (options.recursive && !binding.ownedTreeRemovalAvailable?.(parent.fd)) {
        handled = unavailable();
      } else {
        await removeEntries(parent);
      }
    }
  } catch (error) {
    failed = true;
    operationError = error instanceof MutationAuthorityError ? error : normalize(error);
  }
  const closeErrors: unknown[] = [];
  try { parent?.close(); } catch (error) { closeErrors.push(error); }
  try { await rootAdmission.root.close(); } catch (error) { closeErrors.push(error); }
  if (closeErrors.length) {
    const error = closeErrors.length === 1 ? closeErrors[0] : new AggregateError(closeErrors, "removal descriptors could not close");
    if (failed) throw createSuppressedError(error, operationError, "removal and descriptor close failed");
    throw error;
  }
  if (failed) throw operationError;
  return handled;

  async function removeEntries(admitted: NativeParentAdmission): Promise<void> {
    const guards: AnyAsyncDirectoryGuard[] = [admitted.guard];
    const maxEntries = options.maxEntries ?? 100_000;
    const maxDepth = options.maxDepth ?? 64;
    let examined = 0;
    async function beforeMutation(entryPath: string): Promise<void> {
      try { await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("remove", entryPath); }
      catch (error) { throw normalizeRemoveGuardError(error); }
    }
    function assertCurrent(): void {
      try { options.signal?.throwIfAborted(); } catch (error) { throw new MutationAuthorityError(error); }
      assertRootIdentityCurrentSync(root);
      boundary!.assertCurrent();
      for (const guard of guards) {
        try { assertSyncDirectoryGuard(guard); } catch (cause) {
          throw new FsSafeError("path-mismatch", "removal ancestor changed", { cause });
        }
      }
    }
    function observe(fd: number, name: string, expected?: NativeRootRemovalEntry): NativeRootRemovalEntry | undefined {
      assertCurrent();
      try {
        const entry = inspect(fd, name);
        if (expected && (entry.dev !== expected.dev || entry.ino !== expected.ino || entry.directory !== expected.directory)) {
          throw new FsSafeError("path-mismatch", "removal entry changed");
        }
        if (entry.symlink && options.mutationSymlinks !== undefined) {
          throw new FsSafeError("symlink", "symlink not allowed");
        }
        return entry;
      } catch (error) {
        if (options.force && isNotFoundPathError(error)) return undefined;
        throw error;
      }
    }
    async function visit(fd: number, name: string, entryPath: string, depth: number, counted = false): Promise<void> {
      assertCurrent();
      if (options.recursive && ((!counted && examined >= maxEntries) || depth > maxDepth)) {
        throw new FsSafeError("too-large", "recursive removal budget exceeded");
      }
      if (!counted) examined++;
      if (!options.recursive) await beforeMutation(entryPath);
      await assertMutationNotDenied(entryPath, options.denyMutations, { protectAncestors: true });
      const initial = observe(fd, name);
      if (!initial) return;
      if (!initial.directory && options[nonrecursiveRemovalKind] === "directory") {
        throw new FsSafeError("path-mismatch", "store entry is no longer a directory");
      }
      if (initial.directory && options.recursive) {
        const directory = openDirectory(fd, name, initial.dev, initial.ino);
        try {
          const stat = fs.fstatSync(directory.fd, { bigint: true });
          guards.push({ dir: entryPath, realPath: entryPath, stat });
          try {
            assertCurrent();
            if (options.order === "sorted") {
              const names: string[] = [];
              for (let child = directory.read(); child !== null; child = directory.read()) {
                await scheduler.yield();
                assertCurrent();
                if (examined >= maxEntries) throw new FsSafeError("too-large", "recursive removal budget exceeded");
                examined++;
                names.push(child);
              }
              for (const child of names.sort()) await visit(directory.fd, child, path.join(entryPath, child), depth + 1, true);
            } else {
              for (let child = directory.read(); child !== null; child = directory.read()) {
                await scheduler.yield();
                await visit(directory.fd, child, path.join(entryPath, child), depth + 1);
              }
            }
          } finally { guards.pop(); }
        } finally { directory.close(); }
      }
      if (options.recursive) await beforeMutation(entryPath);
      await assertMutationNotDenied(entryPath, options.denyMutations, { protectAncestors: true });
      if (!observe(fd, name, initial)) return;
      options.assertBeforeMutation?.();
      assertCurrent();
      if (!observe(fd, name, initial)) return;
      try { unlink(fd, name, initial.dev, initial.ino, initial.directory); } catch (error) {
        if (!(options.force && isNotFoundPathError(error))) throw error;
      }
      boundary!.assertAfterMutation();
      assertCurrent();
    }
    await visit(admitted.fd, path.basename(target), target, 0);
  }
}
