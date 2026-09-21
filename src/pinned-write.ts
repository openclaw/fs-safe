import { syncFileBestEffort } from "./file-sync.js";
import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createFileHandle } from "./create.js";
import { creationAdmissionFromParent } from "./creation-path.js";
import { normalizeMaxBytes } from "./byte-budget.js";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard, createNearestExistingDirectoryGuard, inspectDirectoryIdentity, type AsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import type { FileIdentityStat } from "./file-identity.js";
import { sha256Hex } from "./file-identity.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import { runPinnedWriteNative } from "./native-pinned-write.js";
import { getNativeBinding } from "./native.js";
import { validatePinnedOperationPayload } from "./pinned-operation.js";
import { cleanupPinnedFilePath } from "./file-cleanup.js";
import { withSidecarLock } from "./sidecar-lock.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { writePinnedInput } from "./pinned-write-input.js";
import { assertPinnedWriteMode, preparePinnedWriteMode } from "./pinned-write-mode.js";
import { runPinnedStagedWrite } from "./pinned-write-staged.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import type { MutationDirectoryObservation } from "./pinned-mutation-observation.js";
import type { PinnedWriteParams, RenameIdentityPolicy } from "./pinned-write-types.js";

function assertSafeBasename(basename: string): void {
  if (
    !basename ||
    basename === "." ||
    basename === ".." ||
    basename.includes("/") ||
    (process.platform === "win32" && basename.includes("\\")) ||
    basename.includes("\0")
  ) {
    throw new FsSafeError("invalid-path", "invalid target path");
  }
}

function fastParentGuardDeopt(error: unknown): error is FsSafeError {
  return error instanceof FsSafeError &&
    (error.code === "path-mismatch" || error.code === "not-file");
}

const PINNED_WRITE_SNAPSHOT_KEYS: readonly PropertyKey[] = [
  "rootPath", "relativeParentPath", "basename", "maxBytes", "rootIdentity",
];
const RENAME_POLICY_SNAPSHOT_KEYS: readonly PropertyKey[] = ["targetPath", "renameIdentity"];
type OwnedPinnedWriteParams = Omit<
  PinnedWriteParams,
  "rootPath" | "relativeParentPath" | "basename" | "maxBytes" | "rootIdentity"
>;

function copyOwnEnumerableExcept(
  source: object,
  excluded: readonly PropertyKey[],
): Record<PropertyKey, unknown> {
  const owned: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(source)) {
    // Node 22's object-rest fast path can read excluded accessors eagerly.
    // Exclude before even inspecting the descriptor so named authority and
    // pathname fields remain single-read snapshots on every supported Node.
    if (excluded.includes(key)) continue;
    if (!Object.getOwnPropertyDescriptor(source, key)?.enumerable) continue;
    Object.defineProperty(owned, key, {
      value: Reflect.get(source, key),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return owned;
}

export async function runPinnedWriteHelper(params: PinnedWriteParams): Promise<FileIdentityStat> {
  const { rootPath, relativeParentPath, basename, maxBytes, rootIdentity } = params;
  const ownedParams = copyOwnEnumerableExcept(
    params,
    PINNED_WRITE_SNAPSHOT_KEYS,
  ) as OwnedPinnedWriteParams;
  const normalizedParams: PinnedWriteParams = {
    ...ownedParams,
    rootPath,
    relativeParentPath,
    basename,
    maxBytes: normalizeMaxBytes(maxBytes),
    rootIdentity,
  };
  assertSafeBasename(normalizedParams.basename);
  validatePinnedOperationPayload({
    relativeParentPath: normalizedParams.relativeParentPath,
  });
  assertNoWindowsPathAlias(
    normalizedParams.rootPath,
    "filesystem",
    "pinned write root uses a Windows filesystem namespace alias",
  );
  assertNoWindowsPathAlias(
    normalizedParams.relativeParentPath,
    "relative",
    "pinned write parent uses a Windows filesystem namespace alias",
  );
  assertNoWindowsPathAlias(
    normalizedParams.basename,
    "relative",
    "pinned write basename uses a Windows filesystem namespace alias",
  );
  if (rootIdentity !== undefined) {
    normalizedParams.rootIdentity = { dev: rootIdentity.dev, ino: rootIdentity.ino };
  }
  if (normalizedParams.mutationAdmission) {
    const targetPath = path.join(
      normalizedParams.rootPath,
      ...normalizedParams.relativeParentPath.split("/").filter(Boolean),
      normalizedParams.basename,
    );
    await getFsSafeTestHooks()?.beforePinnedWriteParentAdmission?.(targetPath);
  }
  // The explicit compatibility policy uses the guarded Node fallback, where
  // content verification can replace the strict post-rename inode check.
  if (normalizedParams.onRenameIdentityMismatch === "verify-content") {
    return await runPinnedWriteFallback(normalizedParams);
  }
  const native = getNativeBinding();
  if (native) {
    return await runPinnedWriteNative(native, normalizedParams);
  }
  return await runPinnedWriteFallback(normalizedParams);
}

export async function runPinnedWriteWithRenamePolicy(
  params: PinnedWriteParams & {
    targetPath: string;
    renameIdentity?: RenameIdentityPolicy;
  },
): Promise<FileIdentityStat> {
  const { targetPath, renameIdentity } = params;
  const writeParams = copyOwnEnumerableExcept(
    params,
    RENAME_POLICY_SNAPSHOT_KEYS,
  ) as PinnedWriteParams;
  if (renameIdentity !== "verify-content-with-lock") {
    return await runPinnedWriteHelper(writeParams);
  }
  const relativeTargetPath = writeParams.relativeParentPath
    ? `${writeParams.relativeParentPath}/${writeParams.basename}`
    : writeParams.basename;
  return await withPinnedWriteRenameIdentityLock({
    rootPath: writeParams.rootPath, targetPath, relativeTargetPath,
  }, async () => await runPinnedWriteHelper({
    ...writeParams,
    onRenameIdentityMismatch: "verify-content",
  }));
}

export async function withPinnedWriteRenameIdentityLock<T>(
  params: { rootPath: string; targetPath: string; relativeTargetPath: string },
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(
    params.rootPath,
    `.fs-safe-write-${sha256Hex(params.relativeTargetPath)}.lock`,
  );
  return await withSidecarLock(
    params.rootPath,
    {
      managerKey: `fs-safe.write:${params.targetPath}`,
      lockPath,
      staleMs: 30_000,
      timeoutMs: 5_000,
      payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
      retry: { retries: 5, minTimeout: 100, maxTimeout: 2_000, factor: 2 },
    },
    run,
  );
}

async function runPinnedWriteFallback(params: PinnedWriteParams): Promise<FileIdentityStat> {
  const verifyPosixMode = process.platform !== "win32" &&
    (params.verifyPosixMode === true || params.private === true);
  const exactRoot = typeof params.rootIdentity?.dev === "bigint" && typeof params.rootIdentity.ino === "bigint"
    ? { dev: params.rootIdentity.dev, ino: params.rootIdentity.ino } : undefined;
  const mutationAdmission = params.mutationAdmission;
  if (exactRoot) await inspectDirectoryIdentity(params.rootPath, exactRoot);
  let parentPath = params.relativeParentPath
    ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
    : params.rootPath;
  let parentGuard: AsyncDirectoryGuard<BigIntStats> | undefined;
  let parentAdmitted = false;
  const initialTargetPath = path.join(parentPath, params.basename);
  const retainedTargetPath = mutationAdmission?.beginParentWalk?.();
  const ordinaryRetainedTarget = retainedTargetPath !== undefined &&
    path.relative(path.resolve(retainedTargetPath), path.resolve(initialTargetPath)) === "";
  let fastGuardClassifierFailure: FsSafeError | undefined;
  if (ordinaryRetainedTarget) {
    try {
      parentGuard = await createAsyncDirectoryGuard(parentPath, { bigint: true });
    } catch (error) {
      // Only a genuinely missing complete parent may enter the component
      // creator. ENOTDIR, permission, identity, and canonicalization failures
      // retain their original fail-closed result.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        if (!fastParentGuardDeopt(error)) throw error;
        fastGuardClassifierFailure = error;
      }
    }
    if (parentGuard) {
      await mutationAdmission!.authorize(Object.freeze({
        targetPath: initialTargetPath,
        mutationPath: initialTargetPath,
        phase: "parent" as const,
      }));
      await assertAsyncDirectoryGuard(parentGuard);
      parentAdmitted = true;
    }
  }
  if (fastGuardClassifierFailure) {
    // The optimized exact-guard classifier runs before policy admission. Let
    // the established resolver restore deny/symlink precedence before using
    // the guarded walker or reporting the classifier failure. Because this
    // was not an ENOENT probe, it may never authorize a newly missing parent.
    await mutationAdmission!.authorize(Object.freeze({
      targetPath: initialTargetPath,
      mutationPath: initialTargetPath,
      phase: "parent" as const,
    }));
  }
  if (params.mkdir && !parentGuard) {
    // mkdirPathComponentsWithGuards may resolve the final component through
    // an in-root symlink (e.g. a skill-bank layout). Use its returned real
    // path for the subsequent guard and target path so we don't re-check the
    // original, possibly-symlinked, lexical path and reject it outright.
    const mkdirParams = {
      rootReal: params.rootPath,
      targetPath: parentPath,
      rootIdentity: params.rootIdentity,
      assertBeforeMutation: params.assertBeforeMutation,
      beforeComponent: async (componentPath: string) => {
        await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("mkdir", componentPath);
      },
    };
    parentPath = await mkdirPathComponentsWithGuards(mutationAdmission ? {
      ...mkdirParams,
      rejectSymlinks: mutationAdmission.rejectParentSymlinks,
      revalidateParentAfterBeforeComponent: true,
      synchronousAuthorizationIncludesFence: true,
      retainedTargetPath,
      afterCreateComponent: mutationAdmission.advanceCreatedDirectory,
      beforeCreateComponent: (
        componentPath: string,
        prospectiveParentPath: string,
        retainedTarget: string | undefined,
        parent: MutationDirectoryObservation,
      ) => {
        if (fastGuardClassifierFailure) throw fastGuardClassifierFailure;
        const request = Object.freeze({
          targetPath: retainedTarget ?? path.join(prospectiveParentPath, params.basename),
          mutationPath: componentPath,
          phase: "parent-create" as const,
        });
        return mutationAdmission.tryAuthorizeAtParent?.(request, parent) ??
          mutationAdmission.authorize(request);
      },
      beforeUseComponent: async (
        _componentPath: string,
        prospectiveParentPath: string,
        retainedTarget: string | undefined,
      ) => {
        const targetPath = retainedTarget ?? path.join(prospectiveParentPath, params.basename);
        await mutationAdmission.authorize(Object.freeze({
          targetPath,
          mutationPath: targetPath,
          phase: "parent" as const,
        }));
      },
    } : mkdirParams);
  }
  parentGuard ??= params.mkdir
    ? await createAsyncDirectoryGuard(parentPath, { bigint: true })
    : await createNearestExistingDirectoryGuard(params.rootPath, parentPath, { bigint: true });
  const targetPath = path.join(parentPath, params.basename);
  if (mutationAdmission && !parentAdmitted) {
    await mutationAdmission.authorize(Object.freeze({
      targetPath,
      mutationPath: targetPath,
      phase: "parent" as const,
    }));
    await assertAsyncDirectoryGuard(parentGuard);
  }
  if (params.overwrite === false && params.input.kind !== "file" && !params.input.stageBeforePublish) {
    const assertBeforeMutation = () => {
      assertFinalSymlinkRejected(targetPath, params.rejectFinalSymlink);
      params.assertBeforeMutation?.();
    };
    const handle = await withAsyncDirectoryGuards(
      [parentGuard],
      async () => {
        assertBeforeMutation();
        if (params.private) {
          return await createFileHandle(targetPath, {
            private: true, mode: 0o600, assertBeforeMutation,
          }, creationAdmissionFromParent(parentGuard));
        }
        return await fs.open(
          targetPath,
          fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL,
          verifyPosixMode ? 0o600 : params.mode,
        );
      },
      {
        onPostGuardFailure: async (openedHandle) => {
          // The parent failed verification, so targetPath may now resolve
          // somewhere else. Close the fd, but do not clean up by path.
          await openedHandle.close().catch(() => undefined);
        },
      },
    );
    let created = true;
    let completed = false;
    let createdIdentity: BigIntStats | undefined;
    try {
      const verificationIdentity = fsSync.fstatSync(handle.fd, { bigint: true });
      createdIdentity = verificationIdentity;
      const assertBeforeWrite = verifyPosixMode
        ? await preparePinnedWriteMode(handle, Number(createdIdentity.mode & 0o7777n), assertBeforeMutation, params.private)
        : assertBeforeMutation;
      if (verifyPosixMode) assertPinnedWriteMode(handle.fd, 0o600, params.private);
      await writePinnedInput(handle, params.input, params.maxBytes, assertBeforeWrite);
      if (verifyPosixMode) assertPinnedWriteMode(handle.fd, 0o600, params.private);
      // Content writes may clear set-ID bits; finalize them through the owned fd.
      await handle.chmod(params.mode);
      if (verifyPosixMode) assertPinnedWriteMode(handle.fd, params.mode, params.private);
      if (params.sync !== false) {
        if (params.strictFileSync) await handle.sync();
        else await syncFileBestEffort(handle);
      }
      const stat = fsSync.fstatSync(handle.fd);
      if (params.sync !== false) await syncDirectoryBestEffort(parentPath);
      // Publication is complete. A failed outer check must not remove its target.
      created = false;
      await params.verifyPublished?.(handle.fd, verificationIdentity, parentGuard);
      if (verifyPosixMode) assertPinnedWriteMode(handle.fd, params.mode, params.private);
      completed = true;
      return { dev: stat.dev, ino: stat.ino };
    } finally {
      try {
        if (created) {
          await cleanupPinnedFilePath({ pathname: targetPath, handle, identity: createdIdentity, parentGuard });
        }
      } finally {
        if (completed) await handle.close();
        else await handle.close().catch(() => undefined);
      }
    }
  }

  return await runPinnedStagedWrite(params, parentPath, parentGuard);
}
