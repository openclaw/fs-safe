import fs from "node:fs";
import { randomUUID } from "node:crypto";
import fsAsync from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import { assertSyncDirectoryGuard, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { assertDarwinCreationAcl, assertPrivateDirectory } from "./creation-boundary.js";
import { assertMutationNotDenied } from "./deny-mutations.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding, type NativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import { openNativeRootAdmission } from "./native-parent-admission.js";
import { capturePolicyAwareNativeParent } from "./native-policy-parent.js";
import { hasNodeErrorCode, isNotFoundPathError, isPathInside } from "./path.js";
import { preparePinnedWriteMutationAdmission, type PinnedMutationPolicySnapshot } from "./pinned-mutation-admission.js";
import { resolvePathViaExistingAncestor } from "./root-path-existing.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { directoryComponentNotDirectoryError } from "./root-errors.js";
import { assertRootIdentityCurrentSync, type RootContext } from "./root-context.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import type { RootWritePathSelection, RetainedRootWriteSelection } from "./root-write-admission.js";
import type { WritableOpenResult } from "./root-impl.js";
import type { RootOpenWritableOptions } from "./root-options.js";
import { createSuppressedError } from "./suppressed-error.js";

export type OpenedWritableFileInRoot = {
  opened: WritableOpenResult;
  identity: fs.BigIntStats;
  writeSelection?: RetainedRootWriteSelection;
  cleanupCreated?: () => Promise<void>;
  releaseCreationParent?: () => void;
};

export type WritableFileInRootParams = Omit<RootOpenWritableOptions, "writeMode"> & {
  relativePath: string;
  truncateExisting?: boolean;
  append?: boolean;
  expectedWritePath?: string;
  keepCreationParent?: boolean;
};

export function rootWriteQueueKey(root: RootContext, relativePath: string): string {
  return `${root.rootReal}\0${relativePath}`;
}

export function buildAtomicWriteTempPath(targetPath: string): string {
  return path.join(path.dirname(targetPath), `.fs-safe-${randomUUID()}.tmp`);
}

export type MissingWritableFileInRoot = {
  missing: true;
  targetPath: string;
  parentGuard: AnyAsyncDirectoryGuard;
  writeSelection?: RootWritePathSelection;
};

type Creation = {
  root: RootContext;
  directory: string;
  target: string;
  mkdir: boolean;
  private?: boolean;
  policy?: PinnedMutationPolicySnapshot;
  resolveCurrent(): Promise<string>;
  assertBeforeMutation?: () => void;
  originalPath?: string;
};

function unavailable(): never {
  throw new FsSafeError("helper-unavailable", "native confined creation is unavailable");
}

async function withNativeDirectory<T>(
  params: Creation,
  operation: (binding: NativeBinding & Required<Pick<NativeBinding, "openBeneath" | "mkdirChildBeneath">>, fd: number, assertCurrent: () => void) => Promise<T>,
  discard?: (value: T) => Promise<void>,
): Promise<T> {
  const binding = getNativeBinding("openBeneath", "mkdirChildBeneath");
  if (!binding?.openBeneath || !binding.mkdirChildBeneath || (params.private && process.platform === "win32")) return unavailable();
  const directoryTarget = params.directory === params.target;
  const canonicalTarget = async (target: string) => directoryTarget
    ? await resolvePathViaExistingAncestor(target)
    : path.join(await resolvePathViaExistingAncestor(path.dirname(target)), path.basename(target));
  const resolveCurrent = params.resolveCurrent;
  params = { ...params,
    directory: await resolvePathViaExistingAncestor(params.directory),
    target: await canonicalTarget(params.target),
    resolveCurrent: async () => await canonicalTarget(await resolveCurrent()),
  };
  if (!isPathInside(params.root.rootReal, params.directory)) {
    throw new FsSafeError("outside-workspace", "creation parent is outside root");
  }
  const close = captureNativeFdClose(binding);
  let pending: { value: T } | undefined;
  try {
    const admitted = await openNativeRootAdmission(binding, {
      rootPath: params.root.rootReal, rootIdentity: params.root.rootIdentity, operation: "create", reportCloseErrors: true, searchOnly: true,
    });
    await using rootOwner = admitted.root;
    const descriptors: number[] = [];
    using directoryOwner = { [Symbol.dispose]() {
      const errors: unknown[] = [];
      for (const fd of descriptors.reverse()) try { close(fd); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "creation directory close failed");
    } };
    const guards: AnyAsyncDirectoryGuard[] = [];
    function assertCurrent(): void {
      assertRootIdentityCurrentSync(params.root);
      for (const guard of guards) assertSyncDirectoryGuard(guard);
    }
    async function authorize(mutation: string): Promise<void> {
      if (path.relative(params.target, await params.resolveCurrent()) !== "") {
        throw new FsSafeError("path-mismatch", "creation route changed during admission");
      }
      await assertMutationNotDenied(params.target, params.policy?.denyMutations);
      await assertMutationNotDenied(mutation, params.policy?.denyMutations);
      assertCurrent();
    }
    let current = rootOwner.fd;
    let currentPath = params.root.rootReal;
    const flags = (nodeDirectorySearchOnlyFlags()?.flags ?? fs.constants.O_RDONLY) |
      (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
    if (!params.private && !(directoryTarget && params.directory === params.root.rootReal)) {
      if (!admitPathInsideRoot({ rootPath: params.root.rootReal, candidatePath: params.target, rootIdentity: params.root.rootIdentity })) {
        throw new FsSafeError("outside-workspace", "creation target is outside root");
      }
      const relativeParentPath = path.relative(params.root.rootReal, params.directory).split(path.sep).join("/");
      const prepared = await preparePinnedWriteMutationAdmission({
        rootReal: params.root.rootReal, rootIdentity: params.root.rootIdentity,
        resolvedTargetPath: params.target, defaultRelativeParentPath: relativeParentPath,
        originalPath: params.originalPath, policy: params.policy ?? {},
        resolveCurrent: async () => ({ resolved: await params.resolveCurrent() }),
      });
      const parent = await capturePolicyAwareNativeParent(binding, {
        rootPath: params.root.rootReal, rootIdentity: params.root.rootIdentity,
        relativeParentPath, basename: directoryTarget ? "" : path.basename(params.target),
        mkdir: params.mkdir, mode: 0o600, input: { kind: "buffer", data: "" },
        mutationAdmission: prepared.mutationAdmission, assertBeforeMutation: params.assertBeforeMutation,
      }, admitted, process.platform === "win32", flags, true);
      descriptors.push(parent.fd);
      guards.push(parent.guard);
      assertCurrent();
      pending = { value: await operation(binding, parent.fd, assertCurrent) };
      return pending.value;
    }
    for (const segment of path.relative(currentPath, params.directory).split(path.sep).filter(Boolean)) {
      const childPath = path.join(currentPath, segment);
      let child: number;
      let created = false;
      try { child = binding.openBeneath(current, segment, flags).fd; } catch (error) {
        if (!params.mkdir || !isNotFoundPathError(error)) throw error;
        await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("mkdir", childPath);
        await authorize(childPath);
        if (params.private) assertDarwinCreationAcl(current, "directory");
        params.assertBeforeMutation?.();
        assertCurrent();
        if (binding.mkdirOpenChildBeneath) {
          const opened = binding.mkdirOpenChildBeneath(current, segment, params.private ? 0o700 : 0o777, flags);
          created = opened.created;
          child = opened.fd;
        } else {
          created = binding.mkdirChildBeneath(current, segment, params.private ? 0o700 : 0o777);
          child = binding.openBeneath(current, segment, flags).fd;
        }
      }
      descriptors.push(child);
      const stat = inspectFileIdentitySync(() => fs.fstatSync(child, { bigint: true }));
      if (!stat.isDirectory()) throw new FsSafeError("not-file", "creation parent is not a directory");
      guards.push({ dir: childPath, realPath: childPath, stat });
      assertCurrent();
      if (created && params.private) await assertPrivateDirectory(childPath);
      current = child;
      currentPath = childPath;
    }
    await authorize(params.target);
    if (params.private) { await assertPrivateDirectory(currentPath); assertCurrent(); }
    pending = { value: await operation(binding, current, assertCurrent) };
    return pending.value;
  } catch (error) {
    if (pending && discard) {
      try { await discard(pending.value); } catch (cleanupError) {
        throw createSuppressedError(cleanupError, error, "creation handoff and cleanup failed");
      }
    }
    throw error;
  }
}

export async function tryMkdirRootNative(params: Creation): Promise<boolean> {
  // The protected Windows creator already verifies the admitted parent identity
  // and uses handle-relative NtCreateFile with its protected security descriptor.
  if (params.private && process.platform === "win32") return false;
  try {
    return await withNativeDirectory(params, async (_binding, _fd, assertCurrent) => { assertCurrent(); return true; });
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOTDIR")) throw directoryComponentNotDirectoryError(error);
    throw error;
  }
}

export async function tryOpenCreateRootNative(params: Creation & {
  flags: number;
  existingFlags: number;
  mode: number;
}): Promise<{ handle: FileHandle; cleanupCreated(): Promise<void>; releaseCreationParent(): void }> {
  const binding = getNativeBinding("openBeneath", "mkdirChildBeneath", "removeStagedFile", "openCreateBeneath");
  if (!binding?.removeStagedFile || !binding.openCreateBeneath) return unavailable();
  const access = (params.existingFlags & fs.constants.O_RDWR) ? 0o600 : 0o200;
  if (typeof params.mode !== "number") throw Object.assign(new TypeError("mode must be a number"), { code: "ERR_INVALID_ARG_TYPE" });
  if (!Number.isInteger(params.mode) || params.mode < 0 || params.mode > 0xffffffff) {
    throw Object.assign(new RangeError("mode must be an unsigned 32-bit integer"), { code: "ERR_OUT_OF_RANGE" });
  }
  const creationMode = () => {
    const mask = process.umask();
    const desired = params.mode & 0o7777 & ~mask;
    return (desired & access) === access ? desired : undefined;
  };
  // A public FileHandle reopen must not require widening creation permissions.
  if (creationMode() === undefined) return unavailable();
  return await withNativeDirectory(params, async (binding, parent, assertCurrent) => {
    params.assertBeforeMutation?.();
    assertCurrent();
    const mode = creationMode();
    if (mode === undefined) throw new FsSafeError("helper-unavailable", "native creation cannot preserve the requested permissions during handoff");
    // Native creation owns the only O_CREAT dispatch. The subsequent Node open
    // carries neither O_CREAT nor O_TRUNC and must match this retained inode.
    const close = captureNativeFdClose(binding);
    const fd = binding.openCreateBeneath!(parent, path.basename(params.target), params.flags, params.mode & 0o7777);
    let rawOpen = true;
    const closeRaw = () => { if (rawOpen) { rawOpen = false; close(fd); } };
    using owner = { [Symbol.dispose]: closeRaw };
    try {
      const identity = inspectFileIdentitySync(() => fs.fstatSync(fd, { bigint: true }));
      if (!identity.isFile() || identity.nlink !== 1n) throw new FsSafeError("path-mismatch", "created file changed");
      // Keep the kernel's creation-time ACL and umask decisions. chmod here
      // could widen inherited ACL restrictions, even for ordinary mode bits.
      if (process.platform !== "win32" && (Number(identity.mode) & access) !== access) {
        throw new FsSafeError("helper-unavailable", "created permissions do not permit a FileHandle handoff");
      }
      assertCurrent();
      const handle = await fsAsync.open(params.target, params.existingFlags);
      let validatedHandle = false;
      try {
        inspectFileIdentitySync(() => fs.fstatSync(handle.fd, { bigint: true }), identity);
        validatedHandle = true;
        assertCurrent();
        // Close failures still belong to this scope, before transferring either owner.
        closeRaw();
        // Empty relative paths duplicate the admitted descriptor without reopening its name.
        const retainedParent = binding.openBeneath(parent, "", (nodeDirectorySearchOnlyFlags()?.flags ?? fs.constants.O_RDONLY) | (fs.constants.O_DIRECTORY ?? 0)).fd;
        let held = true;
        return { handle, async cleanupCreated() {
          if (!held) return;
          inspectFileIdentitySync(() => fs.fstatSync(handle.fd, { bigint: true }), identity);
          binding.removeStagedFile!(retainedParent, path.basename(params.target), handle.fd);
        }, releaseCreationParent() {
          if (!held) return;
          held = false;
          close(retainedParent);
        } };
      } catch (error) {
        if (!rawOpen && validatedHandle) {
          try { binding.removeStagedFile!(parent, path.basename(params.target), handle.fd); } catch { /* Preserve handoff failure. */ }
        }
        await handle.close();
        throw error;
      }
    } catch (error) {
      if (rawOpen) try { binding.removeStagedFile!(parent, path.basename(params.target), fd); } catch { /* Preserve the admission failure. */ }
      throw error;
    }
  }, async created => {
    await using handle = created.handle;
    using parent = { [Symbol.dispose]: created.releaseCreationParent };
    await created.cleanupCreated();
  });
}
