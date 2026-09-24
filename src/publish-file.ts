import { createHash } from "node:crypto";
import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  pinDirectory,
  type DirectoryReceipt,
  type DirectorySyncOutcome,
} from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { ownDirectoryReceipt } from "./directory-receipt.js";
import { hashFileHandle } from "./file-hash.js";
import {
  sameFileIdentity,
  sameFileIdentityForCleanup,
  type FileIdentityStat,
} from "./file-identity.js";
import { syncFileBestEffortSync } from "./file-sync.js";
import { getNativeBinding, requireNativeBinding, type NativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import {
  directorySyncFailure,
  publicationFailure,
  rememberCreatedTarget,
  type PublishFailureState,
  type PublishFileExclusiveCleanup,
  type PublishFileExclusiveSyncFailurePolicy,
} from "./publish-file-failure.js";
import { admitStandalonePublicationPath, assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { hasErrorCode } from "./file-cleanup.js";
import { writeAllToFile } from "./write-file-handle.js";

export type PublishFileExclusiveStrategy = "link-or-copy" | "link-required" | "rename-noreplace";

export type PublishFileExclusiveResult = {
  method: "hardlink" | "exclusive-copy" | "rename-noreplace";
  identity: Stats;
  directorySync: DirectorySyncOutcome;
};

const HARDLINK_FALLBACK_CODES = new Set(["EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);
const NATIVE_COPY_FALLBACK_CODES = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"]);
export function isHardlinkFallbackError(error: unknown): boolean {
  return HARDLINK_FALLBACK_CODES.has((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

function sourceOpenFlags(): number { return resolveReadOpenFlags(); }

function directoryOpenFlags(): number {
  return (
    fsSync.constants.O_RDONLY |
    (typeof fsSync.constants.O_DIRECTORY === "number" ? fsSync.constants.O_DIRECTORY : 0)
  );
}

async function openNativeParent(filePath: string) {
  const parentPath = path.dirname(filePath);
  const handle = await fs.open(parentPath, directoryOpenFlags());
  try {
    const pathname = fsSync.lstatSync(parentPath, { bigint: true });
    const opened = fsSync.fstatSync(handle.fd, { bigint: true });
    if (pathname.isSymbolicLink() || !sameFileIdentity(pathname, opened)) {
      throw new FsSafeError("path-mismatch", "publication parent changed while opening");
    }
    return { basename: path.basename(filePath), handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function assertPinnedSourceCurrent(params: {
  sourcePath: string;
  handle: FileHandle;
  identity: BigIntStats;
}): void {
  // Windows file indexes can exceed Number.MAX_SAFE_INTEGER, so publication
  // fences must compare bigint stats instead of rounded numeric identities.
  const opened = fsSync.fstatSync(params.handle.fd, { bigint: true });
  const current = fsSync.lstatSync(params.sourcePath, { bigint: true });
  if (
    !opened.isFile() ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameFileIdentity(opened, params.identity) ||
    !sameFileIdentity(current, opened)
  ) {
    throw new FsSafeError("path-mismatch", "publication source changed during operation");
  }
}

function assertPublishedTargetCurrent(targetPath: string, identity: BigIntStats, message: string): void {
  const current = fsSync.lstatSync(targetPath, { bigint: true });
  if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentity(current, identity)) {
    throw new FsSafeError("path-mismatch", message);
  }
}

function assertRenamedSourceAbsent(sourcePath: string): void {
  try {
    fsSync.lstatSync(sourcePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  throw new FsSafeError("path-mismatch", "no-replace publication source still exists");
}

async function copyPinnedSource(params: {
  source: FileHandle;
  targetPath: string;
  native?: NativeBinding;
  targetNativeParent?: Awaited<ReturnType<typeof openNativeParent>>;
  failure: PublishFailureState;
}) {
  if (params.native && params.targetNativeParent) {
    const closeFd = captureNativeFdClose(params.native);
    for (const method of ["clone", "copy-file-range"] as const) {
      let nativeFd: number | undefined;
      try {
        if (method === "clone") {
          nativeFd = params.native.cloneFileExclusive(
            params.source.fd,
            params.targetNativeParent.handle.fd,
            params.targetNativeParent.basename,
          );
        } else {
          const copied = await params.native.copyFileRangeExclusive(
            params.source.fd,
            params.targetNativeParent.handle.fd,
            params.targetNativeParent.basename,
          );
          if (copied.errorCode) {
            throw Object.assign(new Error(copied.errorMessage ?? "native copy failed"), {
              code: copied.errorCode,
            });
          }
          nativeFd = copied.fd;
        }
      } catch (error) {
        if (NATIVE_COPY_FALLBACK_CODES.has((error as NodeJS.ErrnoException).code ?? "")) {
          continue;
        }
        throw error;
      }

      let target: FileHandle | undefined;
      try {
        let createdIdentity = fsSync.fstatSync(nativeFd, { bigint: true });
        rememberCreatedTarget(params.failure, createdIdentity, "copy-verify");
        fsSync.fchmodSync(nativeFd, 0o600);
        createdIdentity = fsSync.fstatSync(nativeFd, { bigint: true });
        await getFsSafeTestHooks()?.afterPublishTargetCreated?.(
          "exclusive-copy",
          params.targetPath,
          createdIdentity,
        );
        const identity = fsSync.lstatSync(params.targetPath, { bigint: true });
        target = await fs.open(params.targetPath, sourceOpenFlags());
        const opened = fsSync.fstatSync(target.fd, { bigint: true });
        if (
          identity.isSymbolicLink() ||
          !identity.isFile() ||
          !sameFileIdentity(createdIdentity, identity) ||
          !sameFileIdentity(createdIdentity, opened)
        ) {
          throw new FsSafeError("path-mismatch", "native publication target changed after copy");
        }
        const hashed = await hashFileHandle(target, params.native);
        const completedFd = nativeFd;
        nativeFd = undefined;
        closeFd(completedFd);
        return {
          handle: target,
          exactIdentity: opened,
          digest: hashed.digest,
          bytes: hashed.bytes,
        };
      } catch (error) {
        await target?.close().catch(() => undefined);
        throw error;
      } finally {
        if (nativeFd !== undefined) closeFd(nativeFd);
      }
    }
  }

  const target = await fs.open(params.targetPath, "wx+", 0o600);
  try {
    const createdIdentity = fsSync.fstatSync(target.fd, { bigint: true });
    rememberCreatedTarget(params.failure, createdIdentity, "copy-verify");
    await target.chmod(0o600);
    const exactIdentity = fsSync.fstatSync(target.fd, { bigint: true });
    await getFsSafeTestHooks()?.afterPublishTargetCreated?.(
      "exclusive-copy",
      params.targetPath,
      exactIdentity,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await params.source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await writeAllToFile(target, chunk, { position });
      position += bytesRead;
    }
    await target.sync();
    return { handle: target, exactIdentity, digest: hash.digest("hex"), bytes: position };
  } catch (error) {
    await target.close().catch(() => undefined);
    throw error;
  }
}

async function removeCreatedTargetIfUnchanged(
  targetPath: string,
  identity?: FileIdentityStat,
): Promise<PublishFileExclusiveCleanup> {
  if (!identity) {
    return "unknown";
  }
  try {
    const current = fsSync.lstatSync(targetPath, { bigint: true });
    if (!current.isSymbolicLink() && sameFileIdentityForCleanup(current, identity)) {
      await fs.rm(targetPath);
      return "removed";
    }
    return "preserved";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "removed" : "unknown";
  }
}

async function syncPublishedParent(params: {
  parent: Awaited<ReturnType<typeof pinDirectory>>;
  failure: PublishFailureState;
  method: PublishFileExclusiveResult["method"];
  targetPath: string;
}): Promise<DirectorySyncOutcome> {
  params.failure.phase = "directory-sync";
  try {
    await getFsSafeTestHooks()?.beforePublishDirectorySync?.(
      params.method,
      params.targetPath,
      params.failure.targetIdentity!,
    );
    // PinnedDirectory.sync() revalidates descriptor/path identity immediately
    // before and after fsync; keep that check inside the shared sync boundary.
    return await params.parent.sync();
  } catch (error) {
    params.failure.directorySync = directorySyncFailure(error);
    throw error;
  }
}

export async function publishFileExclusive(params: {
  sourcePath: string;
  targetPath: string;
  expectedSourceIdentity?: FileIdentityStat;
  strategy: PublishFileExclusiveStrategy;
  onSyncFailure?: PublishFileExclusiveSyncFailurePolicy;
  parentReceipt?: DirectoryReceipt<Stats | BigIntStats>;
}): Promise<PublishFileExclusiveResult> {
  const sourcePathInput = admitStandalonePublicationPath(params.sourcePath, "publication source uses a Windows filesystem namespace alias");
  const targetPathInput = admitStandalonePublicationPath(params.targetPath, "publication target uses a Windows filesystem namespace alias");
  const parentReceiptInput = params.parentReceipt;
  const parentReceipt = parentReceiptInput
    ? ownDirectoryReceipt(parentReceiptInput)
    : undefined;
  if (parentReceipt) {
    assertNoWindowsPathAlias(parentReceipt.path, "filesystem", "publication parent uses a Windows filesystem namespace alias");
  }
  const sourcePath = path.resolve(sourcePathInput);
  const targetPath = path.resolve(targetPathInput);
  assertNoWindowsPathAlias(sourcePath, "filesystem", "publication source uses a Windows filesystem namespace alias");
  assertNoWindowsPathAlias(targetPath, "filesystem", "publication target uses a Windows filesystem namespace alias");
  const parentPath = path.dirname(targetPath);
  if (parentReceipt && path.resolve(parentReceipt.path) !== parentPath) {
    throw new FsSafeError("path-mismatch", "publication parent receipt does not match target parent");
  }
  if (parentReceipt) {
    assertNoWindowsPathAlias(parentReceipt.realPath, "filesystem", "publication parent uses a Windows filesystem namespace alias");
  }

  const sourcePathStat = fsSync.lstatSync(sourcePath);
  if (sourcePathStat.isSymbolicLink() || !sourcePathStat.isFile()) {
    throw new FsSafeError("not-file", "publication source must be a regular file");
  }
  const source = await fs.open(sourcePath, sourceOpenFlags());
  let parent: Awaited<ReturnType<typeof pinDirectory>> | undefined;
  let sourceNativeParent: Awaited<ReturnType<typeof openNativeParent>> | undefined;
  let targetNativeParent: Awaited<ReturnType<typeof openNativeParent>> | undefined;
  let copiedTarget: FileHandle | undefined;
  const strategy = params.strategy;
  const failure: PublishFailureState = {
    phase: strategy === "rename-noreplace" ? "rename-create" : "hardlink-create",
    targetCreated: false,
    preserveTarget: false,
  };
  try {
    parent = await pinDirectory(parentReceipt ?? parentPath, {
      label: "publication parent",
    });
    const sourceIdentity = fsSync.fstatSync(source.fd);
    const sourceExactIdentity = fsSync.fstatSync(source.fd, { bigint: true });
    const sourcePathExactIdentity = fsSync.lstatSync(sourcePath, { bigint: true });
    const expectedSourceIdentity = params.expectedSourceIdentity;
    if (
      sourcePathExactIdentity.isSymbolicLink() ||
      !sourcePathExactIdentity.isFile() ||
      !sameFileIdentity(sourcePathExactIdentity, sourceExactIdentity) ||
      (expectedSourceIdentity &&
        !sameFileIdentity(
          expectedSourceIdentity,
          typeof expectedSourceIdentity.dev === "bigint" ||
            typeof expectedSourceIdentity.ino === "bigint"
            ? sourceExactIdentity
            : sourceIdentity,
        ))
    ) {
      throw new FsSafeError("path-mismatch", "publication source identity did not match");
    }
    const assertSourceCurrent = () => assertPinnedSourceCurrent({ sourcePath, handle: source, identity: sourceExactIdentity });
    const finishPublication = async (
      method: PublishFileExclusiveResult["method"], handle: FileHandle, identity: BigIntStats,
    ): Promise<PublishFileExclusiveResult> => {
      const verifyPhase = failure.phase;
      const directorySync = await syncPublishedParent({ parent: parent!, failure, method, targetPath });
      failure.phase = verifyPhase;
      if (method === "rename-noreplace") assertRenamedSourceAbsent(sourcePath);
      else assertSourceCurrent();
      assertPublishedTargetCurrent(targetPath, identity, "publication target changed during directory sync");
      return { method, identity: fsSync.fstatSync(handle.fd), directorySync };
    };
    await parent.assertCurrent();
    assertSourceCurrent();

    const native = strategy === "rename-noreplace"
      ? requireNativeBinding()
      : getNativeBinding();
    if (native) {
      sourceNativeParent = await openNativeParent(sourcePath);
      targetNativeParent = await openNativeParent(targetPath);
    }

    if (strategy === "rename-noreplace") {
      const binding = requireNativeBinding();
      binding.renameNoReplace(
        sourceNativeParent!.handle.fd,
        sourceNativeParent!.basename,
        targetNativeParent!.handle.fd,
        targetNativeParent!.basename,
      );
      rememberCreatedTarget(failure, sourceExactIdentity, "rename-verify");
      // A failed post-rename fence must not delete the only remaining name.
      failure.preserveTarget = true;
      await getFsSafeTestHooks()?.afterPublishTargetCreated?.(
        "rename-noreplace",
        targetPath,
        sourceExactIdentity,
      );
      assertPublishedTargetCurrent(targetPath, sourceExactIdentity, "no-replace publication target changed");
      assertRenamedSourceAbsent(sourcePath);
      syncFileBestEffortSync(sourceNativeParent!.handle.fd);
      return await finishPublication("rename-noreplace", source, sourceExactIdentity);
    }

    try {
      if (native) {
        native.linkBeneath(
          sourceNativeParent!.handle.fd,
          sourceNativeParent!.basename,
          targetNativeParent!.handle.fd,
          targetNativeParent!.basename,
        );
      } else {
        await fs.link(sourcePath, targetPath);
      }
      rememberCreatedTarget(failure, sourceExactIdentity, "hardlink-verify");
      await getFsSafeTestHooks()?.afterPublishTargetCreated?.(
        "hardlink",
        targetPath,
        sourceExactIdentity,
      );
      assertPublishedTargetCurrent(targetPath, sourceExactIdentity, "hardlink publication target changed");
      assertSourceCurrent();
      return await finishPublication("hardlink", source, sourceExactIdentity);
    } catch (error) {
      if (
        failure.targetCreated ||
        !isHardlinkFallbackError(error) ||
        strategy === "link-required"
      ) {
        throw error;
      }
    }

    failure.phase = "copy-create";
    const copied = await copyPinnedSource({ source, targetPath, native, targetNativeParent, failure });
    copiedTarget = copied.handle;
    const copiedBack = await hashFileHandle(copiedTarget, native);
    const sourceAfter = await hashFileHandle(source, native);
    assertPublishedTargetCurrent(targetPath, copied.exactIdentity, "exclusive publication copy failed content fencing");
    if (
      copiedBack.bytes !== copied.bytes ||
      copiedBack.digest !== copied.digest ||
      sourceAfter.bytes !== copied.bytes ||
      sourceAfter.digest !== copied.digest
    ) {
      throw new FsSafeError("path-mismatch", "exclusive publication copy failed content fencing");
    }
    assertSourceCurrent();
    return await finishPublication("exclusive-copy", copiedTarget, copied.exactIdentity);
  } catch (error) {
    if (!failure.targetCreated) throw error;
    const preserveSyncFailure =
      failure.phase === "directory-sync" && params.onSyncFailure === "preserve";
    const cleanup = failure.preserveTarget || preserveSyncFailure
      ? "preserved"
      : await removeCreatedTargetIfUnchanged(targetPath, failure.targetCleanupIdentity);
    throw publicationFailure(error, failure, cleanup);
  } finally {
    await copiedTarget?.close().catch(() => undefined);
    await sourceNativeParent?.handle.close().catch(() => undefined);
    await targetNativeParent?.handle.close().catch(() => undefined);
    await source.close().catch(() => undefined);
    await parent?.close().catch(() => undefined);
  }
}
