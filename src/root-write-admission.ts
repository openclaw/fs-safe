import fsSync from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { assertMutationNotDenied, type DenyMutationPolicy } from "./deny-mutations.js";
import {
  assertAsyncDirectoryGuard,
  assertSyncDirectoryGuard,
  createAsyncDirectoryGuard,
  type AnyAsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { assertNoPathAliasEscape } from "./path-policy.js";
import {
  preparePinnedWriteMutationAdmission,
  snapshotPinnedMutationPolicy,
} from "./pinned-mutation-admission.js";
import type { PinnedWriteMutationAdmission } from "./pinned-write.js";
import { admitPathInsideRoot, sameNormalizedPathSpelling } from "./root-boundary.js";
import type { RootContext } from "./root-context.js";
import { resolvePathInRoot } from "./root-context.js";
import { hardlinkedPathNotAllowedError, outsideWorkspaceError } from "./root-errors.js";
import { inheritWriteTargetMode } from "./root-write-mode.js";
import {
  mutationSymlinkResolution,
  type MutationSymlinkPolicy,
} from "./root-symlink-policy.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { realpathSync } from "./realpath.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import {
  assertPreparedRootWriteParentCurrent,
  type PreparedRootWriteParent,
} from "./root-write-complete-parent.js";

export type PinnedWriteTarget = Readonly<{
  rootReal: string;
  targetPath: string;
  relativeParentPath: string;
  basename: string;
  mode: number;
  mutationAdmission?: PinnedWriteMutationAdmission;
}>;

export type GuardedWritePath = Awaited<ReturnType<typeof resolvePathInRoot>>;

export type SelectedRootWriteTargetAdmission = Readonly<{
  authorize(selectedTargetPath: string): Promise<void>;
}>;

export type GuardedRootWriteTarget = Readonly<{
  resolvedPath: GuardedWritePath;
  targetPath: string;
  mutationAdmission?: PinnedWriteMutationAdmission;
  selectedTargetAdmission?: SelectedRootWriteTargetAdmission;
}>;

export type RootWritePathSelection = Readonly<{
  mutationAdmission: PinnedWriteMutationAdmission;
  selectedTargetAdmission: SelectedRootWriteTargetAdmission;
  operationTargetPath: string;
  selectedPath: string;
  parentGuard: AnyAsyncDirectoryGuard;
}>;

export type RetainedRootWriteSelection = RootWritePathSelection & Readonly<{
  identity: Readonly<Pick<BigIntStats, "dev" | "ino">>;
}>;

export function createRootWriteSelectionForFd(
  selection: RootWritePathSelection,
  fd: number,
): RetainedRootWriteSelection {
  const stat = inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true }));
  return Object.freeze({
    ...selection,
    identity: Object.freeze({ dev: stat.dev, ino: stat.ino }),
  });
}

function writeSelectionChanged(cause?: unknown): FsSafeError {
  return new FsSafeError("path-mismatch", "write target changed during operation", {
    cause: cause instanceof Error ? cause : undefined,
  });
}

function inspectRegularSelectionPath(
  pathname: string,
  expected: RetainedRootWriteSelection["identity"] | undefined,
  follow: boolean,
): BigIntStats {
  let observed: BigIntStats;
  try {
    observed = inspectFileIdentitySync(
      () => follow
        ? fsSync.statSync(pathname, { bigint: true })
        : fsSync.lstatSync(pathname, { bigint: true }),
      expected,
    );
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "path-mismatch") throw error;
    throw writeSelectionChanged(error);
  }
  if ((!follow && observed.isSymbolicLink()) || !observed.isFile()) {
    throw writeSelectionChanged();
  }
  if (observed.nlink > 1n) throw hardlinkedPathNotAllowedError();
  return observed;
}

function inspectSelectionBindingSync(
  root: RootContext,
  selection: RetainedRootWriteSelection,
  fd?: number,
): void {
  inspectRegularSelectionPath(selection.selectedPath, selection.identity, false);
  if (!sameNormalizedPathSpelling(selection.operationTargetPath, selection.selectedPath)) {
    let operationRealPath: string;
    try {
      operationRealPath = realpathSync.native(selection.operationTargetPath);
    } catch (error) {
      throw writeSelectionChanged(error);
    }
    const admitted = admitPathInsideRoot({
      rootPath: root.rootReal,
      candidatePath: operationRealPath,
      rootIdentity: root.rootIdentity,
    });
    if (!admitted) throw outsideWorkspaceError();
    inspectRegularSelectionPath(admitted.path, selection.identity, true);
  }
  if (fd !== undefined) {
    try {
      inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true }), selection.identity);
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "path-mismatch") throw error;
      throw writeSelectionChanged(error);
    }
  }
}

export function assertRootWritePathSelectionSync(
  root: RootContext,
  selection: RootWritePathSelection,
): void {
  if (!sameNormalizedPathSpelling(selection.operationTargetPath, selection.selectedPath)) {
    let operationRealPath: string;
    try {
      operationRealPath = realpathSync.native(selection.operationTargetPath);
    } catch (error) {
      throw writeSelectionChanged(error);
    }
    const admitted = admitPathInsideRoot({
      rootPath: root.rootReal,
      candidatePath: operationRealPath,
      rootIdentity: root.rootIdentity,
    });
    if (!admitted) throw outsideWorkspaceError();
    const selected = inspectRegularSelectionPath(selection.selectedPath, undefined, false);
    inspectRegularSelectionPath(admitted.path, selected, true);
  }
  assertSyncDirectoryGuard(selection.parentGuard);
}

export function assertRootWriteSelectionSync(
  root: RootContext,
  selection: RetainedRootWriteSelection,
  verifyBinding: boolean,
  fd?: number,
): void {
  if (verifyBinding) inspectSelectionBindingSync(root, selection, fd);
  assertSyncDirectoryGuard(selection.parentGuard);
}

async function authorizeRootWritePathSelection(
  selection: RootWritePathSelection,
  afterAwait?: (selectedAdmissionPending: boolean) => void,
): Promise<void> {
  const selectedAdmissionPending = !sameNormalizedPathSpelling(
    selection.operationTargetPath,
    selection.selectedPath,
  );
  await selection.mutationAdmission.authorize(Object.freeze({
    targetPath: selection.operationTargetPath,
    mutationPath: selection.operationTargetPath,
    phase: "parent" as const,
  }));
  afterAwait?.(selectedAdmissionPending);
  if (selectedAdmissionPending) {
    await selection.selectedTargetAdmission.authorize(selection.selectedPath);
    afterAwait?.(false);
  }
}

export async function prepareRootWritePathSelection(params: Omit<
  RootWritePathSelection,
  "parentGuard"
> & Readonly<{
  preparedParent?: PreparedRootWriteParent;
}>): Promise<RootWritePathSelection> {
  const { preparedParent, ...selectionParams } = params;
  if (preparedParent && (
    !sameNormalizedPathSpelling(preparedParent.operationTargetPath, params.operationTargetPath) ||
    !sameNormalizedPathSpelling(preparedParent.parentGuard.dir, path.dirname(params.operationTargetPath))
  )) throw writeSelectionChanged();
  const selection: RootWritePathSelection = Object.freeze({
    ...selectionParams,
    parentGuard: preparedParent?.parentGuard ??
      await createAsyncDirectoryGuard(path.dirname(params.selectedPath), { bigint: true }),
  });
  await authorizeRootWritePathSelection(
    selection,
    preparedParent
      ? (selectedAdmissionPending) => assertPreparedRootWriteParentCurrent(
        preparedParent,
        !selectedAdmissionPending,
      )
      : undefined,
  );
  if (preparedParent) {
    if (!sameNormalizedPathSpelling(preparedParent.selectedTargetPath, params.selectedPath)) {
      throw writeSelectionChanged();
    }
  } else {
    await assertAsyncDirectoryGuard(selection.parentGuard);
  }
  return selection;
}

export async function prepareGuardedRootWritePathSelection(
  guarded: {
    mutationAdmission?: PinnedWriteMutationAdmission;
    selectedTargetAdmission?: SelectedRootWriteTargetAdmission;
  } | undefined,
  selectedPath: string,
  operationTargetPath = selectedPath,
  preparedParent?: PreparedRootWriteParent,
): Promise<RootWritePathSelection | undefined> {
  if (!guarded?.mutationAdmission) return undefined;
  if (!guarded.selectedTargetAdmission) throw writeSelectionChanged();
  return await prepareRootWritePathSelection({
    mutationAdmission: guarded.mutationAdmission,
    selectedTargetAdmission: guarded.selectedTargetAdmission,
    operationTargetPath,
    selectedPath,
    preparedParent,
  });
}

export async function refreshRootWritePathSelection(
  selection: RootWritePathSelection,
): Promise<void> {
  await authorizeRootWritePathSelection(selection);
  await assertAsyncDirectoryGuard(selection.parentGuard);
}

/**
 * Re-authorize a retained shared-JavaScript destination without recapturing
 * either its pathname binding or its exact parent fence.
 */
export async function refreshRootWriteSelection(
  root: RootContext,
  selection: RetainedRootWriteSelection,
  verifyBinding: boolean,
  fd?: number,
): Promise<void> {
  await authorizeRootWritePathSelection(selection);
  if (verifyBinding) inspectSelectionBindingSync(root, selection, fd);
  await assertAsyncDirectoryGuard(selection.parentGuard);
}

export async function refreshRetainedRootWriteAdmission(
  root: RootContext,
  selection: RetainedRootWriteSelection,
  verifyBinding: boolean,
  fd?: number,
): Promise<void> {
  await getFsSafeTestHooks()?.beforePinnedWriteParentAdmission?.(
    selection.operationTargetPath,
  );
  await refreshRootWriteSelection(root, selection, verifyBinding, fd);
}

type GuardedWritePathOptions = {
  relativePath: string;
  denyMutations?: DenyMutationPolicy;
  mutationSymlinks?: MutationSymlinkPolicy;
  allowFinalSymlink?: boolean;
  protectDeniedAncestors?: boolean;
  shouldAssertNoPathAlias?: (resolved: GuardedWritePath) => Promise<boolean> | boolean;
};

export async function resolveGuardedWritePathInRoot(
  root: RootContext,
  params: GuardedWritePathOptions,
): Promise<GuardedWritePath> {
  const resolvedPath = await resolvePathInRoot(root, params.relativePath, {
    aliasErrorCode: "path-alias",
    rejectAmbiguousParents: true,
    allowFinalSymlink: params.allowFinalSymlink,
    ...mutationSymlinkResolution(params.mutationSymlinks),
  });
  await assertMutationNotDenied(
    resolvedPath.resolved,
    params.denyMutations,
    params.protectDeniedAncestors ? { protectAncestors: true } : undefined,
  );
  if (await (params.shouldAssertNoPathAlias?.(resolvedPath) ?? true)) {
    try {
      await assertNoPathAliasEscape({
        absolutePath: resolvedPath.resolved,
        rootPath: resolvedPath.rootReal,
        boundaryLabel: "root",
      });
    } catch (error) {
      throw new FsSafeError("path-alias", "path alias escape blocked", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
  return resolvedPath;
}

export async function resolveGuardedWriteTargetInRoot(
  root: RootContext,
  params: GuardedWritePathOptions,
): Promise<GuardedRootWriteTarget> {
  const policy = params.denyMutations === undefined && params.mutationSymlinks === undefined
    ? undefined
    : snapshotPinnedMutationPolicy(params.denyMutations, params.mutationSymlinks);
  const resolveCurrent = async () => await resolveGuardedWritePathInRoot(root, {
    ...params,
    denyMutations: policy?.denyMutations,
    mutationSymlinks: policy?.mutationSymlinks,
  });
  const resolvedPath = await resolveCurrent();
  if (!policy) return { resolvedPath, targetPath: resolvedPath.resolved };
  const relativeParent = path.relative(resolvedPath.rootReal, path.dirname(resolvedPath.resolved));
  const prepared = await preparePinnedWriteMutationAdmission({
    rootReal: resolvedPath.rootReal,
    rootWithSep: resolvedPath.rootWithSep,
    rootIdentity: root.rootIdentity,
    resolvedTargetPath: resolvedPath.resolved,
    originalPath: params.relativePath,
    defaultRelativeParentPath: relativeParent
      ? relativeParent.split(path.sep).join(path.posix.sep)
      : "",
    policy,
    resolveCurrent,
  });
  const selectedTargetAdmission: SelectedRootWriteTargetAdmission = Object.freeze({
    async authorize(selectedTargetPath) {
      const admitted = admitPathInsideRoot({
        rootPath: root.rootReal,
        candidatePath: selectedTargetPath,
        rootIdentity: root.rootIdentity,
      });
      if (!admitted) throw outsideWorkspaceError();
      await resolveGuardedWritePathInRoot(root, {
        relativePath: admitted.relativePath,
        denyMutations: policy.denyMutations,
        mutationSymlinks: policy.mutationSymlinks,
      });
    },
  });
  const targetPath = path.join(
    resolvedPath.rootReal,
    ...prepared.relativeParentPath.split("/").filter(Boolean),
    path.basename(resolvedPath.resolved),
  );
  return {
    resolvedPath,
    targetPath,
    mutationAdmission: prepared.mutationAdmission,
    selectedTargetAdmission,
  };
}

export async function resolvePinnedWriteTargetInRoot(
  root: RootContext,
  relativePath: string,
  requestedMode?: number,
  denyMutations?: DenyMutationPolicy,
  overwrite = true,
  mutationSymlinks?: MutationSymlinkPolicy,
): Promise<PinnedWriteTarget> {
  // Snapshot mutable caller-owned policy before preflight so every admission
  // in this operation authorizes the same rules.
  const policy = denyMutations === undefined && mutationSymlinks === undefined
    ? undefined
    : snapshotPinnedMutationPolicy(denyMutations, mutationSymlinks);
  const resolveCurrent = policy
    ? async () => await resolveGuardedWritePathInRoot(root, {
      relativePath,
      denyMutations: policy.denyMutations,
      mutationSymlinks: policy.mutationSymlinks,
    })
    : undefined;
  const { rootReal, rootWithSep, resolved } = resolveCurrent
    ? await resolveCurrent()
    : await resolveGuardedWritePathInRoot(root, { relativePath });

  const relativeResolved = path.relative(rootReal, resolved);
  if (path.isAbsolute(relativeResolved)) throw outsideWorkspaceError();
  const relativePosix = relativeResolved
    ? relativeResolved.split(path.sep).join(path.posix.sep)
    : "";
  const basename = path.posix.basename(relativePosix);
  if (!basename || basename === "." || basename === "/") {
    throw new FsSafeError("invalid-path", "invalid target path");
  }
  if (!overwrite) {
    try {
      const existing = fsSync.statSync(resolved);
      if (!existing.isFile()) throw new FsSafeError("not-file", "not a file");
      if (existing.nlink > 1) throw hardlinkedPathNotAllowedError();
      throw new FsSafeError("already-exists", "file already exists");
    } catch (error) {
      if (!isNotFoundPathError(error)) throw error;
    }
  }
  const mode = overwrite
    ? await inheritWriteTargetMode({
      targetPath: resolved,
      rootWithSep,
      rootIdentity: root.rootIdentity,
      requestedMode,
    })
    : requestedMode ?? 0o600;

  let relativeParentPath =
    path.posix.dirname(relativePosix) === "." ? "" : path.posix.dirname(relativePosix);
  let mutationAdmission: PinnedWriteMutationAdmission | undefined;
  if (policy) {
    ({ relativeParentPath, mutationAdmission } = await preparePinnedWriteMutationAdmission({
      rootReal,
      rootWithSep,
      rootIdentity: root.rootIdentity,
      resolvedTargetPath: resolved,
      originalPath: relativePath,
      defaultRelativeParentPath: relativeParentPath,
      policy,
      resolveCurrent: resolveCurrent!,
    }));
  }

  return { rootReal, targetPath: resolved, relativeParentPath, basename, mode, mutationAdmission };
}
