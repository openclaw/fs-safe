import { randomUUID } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { assertAsyncDirectoryGuard, assertSyncDirectoryGuard, createAsyncDirectoryGuard, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import type { NativeBinding } from "./native-binding.js";
import { getNativeBinding } from "./native.js";
import { isFsSafeNativeRequired } from "./native-config.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { timestampSeconds } from "./copy-metadata.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import type { PinnedWriteParams } from "./pinned-write-types.js";
import { noReplaceUnavailable } from "./native-noreplace.js";
import { createSuppressedError } from "./suppressed-error.js";

export type CopyLinkInput = {
  kind: "link";
  stageBeforePublish: true;
  sourcePath: string;
  identity: BigIntStats;
  target?: Buffer;
  preserveMetadata: boolean;
  signal?: AbortSignal;
  verifySource(): Promise<void>;
};

/** Shared by tree byte copying and per-file copying; never resolves the target. */
export async function readCopyLinkTarget(source: string): Promise<Buffer> {
  return await fsp.readlink(source, { encoding: "buffer" });
}

export function assertCopyLinkAvailable(): void {
  const native = getNativeBinding();
  if (process.platform === "darwin" && !native?.createCopySymlink) {
    throw new FsSafeError("helper-unavailable", "exclusive macOS link copying requires the native helper; link(2) follows its source");
  }
  if (process.platform === "win32" && (!native?.copyLinkExclusive || !native.publishCopyLink || !native.removeCopyLink)) {
    throw new FsSafeError("helper-unavailable", "copying Windows links without following them requires the native helper");
  }
  if (native && process.platform !== "win32" && !native.createCopySymlink) {
    throw new FsSafeError("helper-unavailable", "native link copying is unavailable");
  }
}

export async function admitCopyLink(sourcePath: string, preserveMetadata: boolean, signal?: AbortSignal): Promise<CopyLinkInput | undefined> {
  const parent = await createAsyncDirectoryGuard(path.dirname(sourcePath), { bigint: true });
  sourcePath = path.join(parent.realPath, path.basename(sourcePath));
  const identity = fs.lstatSync(sourcePath, { bigint: true });
  if (!identity.isSymbolicLink()) return undefined;
  const target = process.platform === "win32" ? undefined : await readCopyLinkTarget(sourcePath);
  const verifySource = async () => {
    signal?.throwIfAborted();
    await assertAsyncDirectoryGuard(parent);
    const current = inspectFileIdentitySync(() => fs.lstatSync(sourcePath, { bigint: true }), identity);
    if (!current.isSymbolicLink() || current.mtimeNs !== identity.mtimeNs || current.ctimeNs !== identity.ctimeNs) {
      throw new FsSafeError("path-mismatch", "copy source link changed");
    }
  };
  await verifySource();
  return { kind: "link", stageBeforePublish: true, sourcePath, identity, target, preserveMetadata, signal, verifySource };
}

/** The caller has admitted the destination parent under Root's mutation policy. */
export async function copyLinkAtParent(
  params: PinnedWriteParams,
  input: CopyLinkInput,
  parent: AnyAsyncDirectoryGuard,
  native?: { binding: NativeBinding; fd: number },
): Promise<{ dev: bigint; ino: bigint }> {
  const temporaryName = `.fs-safe-${randomUUID()}.tmp`;
  const temporaryPath = path.join(parent.realPath, temporaryName);
  const destination = path.join(parent.realPath, params.basename);
  let identity: { dev: bigint; ino: bigint } | undefined;
  let sourceParent: fsp.FileHandle | undefined;
  let failure: { error: unknown } | undefined;
  const assertStage = () => {
    assertSyncDirectoryGuard(parent);
    const stat = inspectFileIdentitySync(() => fs.lstatSync(temporaryPath, { bigint: true }), identity!);
    if (!stat.isSymbolicLink() || stat.nlink !== 1n) throw new FsSafeError("path-mismatch", "copy link stage changed");
  };
  try {
    await input.verifySource();
    await assertAsyncDirectoryGuard(parent);
    if (process.platform === "win32") {
      if (!native?.binding.copyLinkExclusive) throw new FsSafeError("helper-unavailable", "native Windows link copying is unavailable");
      const sourceGuard = await createAsyncDirectoryGuard(path.dirname(input.sourcePath), { bigint: true });
      sourceParent = await fsp.open(sourceGuard.realPath, fs.constants.O_RDONLY);
      inspectFileIdentitySync(() => fs.fstatSync(sourceParent!.fd, { bigint: true }), sourceGuard.stat);
      await input.verifySource();
      params.assertBeforeMutation?.();
      assertSyncDirectoryGuard(parent);
      identity = native.binding.copyLinkExclusive(sourceParent.fd, path.basename(input.sourcePath), native.fd,
        temporaryName, input.identity.dev, input.identity.ino, input.preserveMetadata, params.mode);
    } else {
      if (native && !native.binding.createCopySymlink) throw new FsSafeError("helper-unavailable", "native link copying is unavailable");
      params.assertBeforeMutation?.();
      assertSyncDirectoryGuard(parent);
      if (native?.binding.createCopySymlink) {
        const created = native.binding.createCopySymlink(native.fd, temporaryName, input.target!, params.mode,
          input.preserveMetadata ? input.identity.atimeNs : undefined,
          input.preserveMetadata ? input.identity.mtimeNs : undefined);
        identity = created;
        if (created.errorCode) throw Object.assign(new Error(created.errorMessage), { code: created.errorCode });
      } else {
        fs.symlinkSync(input.target!, temporaryPath);
        identity = fs.lstatSync(temporaryPath, { bigint: true });
      }
      if (!native && input.preserveMetadata) {
        assertStage();
        fs.lutimesSync(temporaryPath, timestampSeconds(input.identity.atimeNs), timestampSeconds(input.identity.mtimeNs));
      }
    }
    assertStage();
    await input.verifySource();
    params.assertBeforeMutation?.();
    input.signal?.throwIfAborted();
    assertStage();
    if (process.platform === "win32") {
      native!.binding.publishCopyLink!(native!.fd, temporaryName, params.basename, identity.dev, identity.ino);
    } else if (native) {
      const renameNoReplace = native.binding.renameNoReplace;
      if (!renameNoReplace) throw new FsSafeError("helper-unavailable", "native link publication is unavailable");
      try {
        renameNoReplace(native.fd, temporaryName, native.fd, params.basename);
      } catch (error) {
        const unavailable = noReplaceUnavailable(error, "link copy publication", true);
        if (!unavailable || isFsSafeNativeRequired() || process.platform !== "linux") throw error;
        // Linux link(2) links the symlink inode itself, never its target.
        assertStage();
        fs.linkSync(temporaryPath, destination);
      }
    } else {
      fs.linkSync(temporaryPath, destination);
    }
    params.onPublished?.(identity);
    assertSyncDirectoryGuard(parent);
    const final = inspectFileIdentitySync(() => fs.lstatSync(destination, { bigint: true }), identity);
    if (!final.isSymbolicLink()) throw new FsSafeError("path-mismatch", "published copy link changed");
    if (params.sync !== false) await syncDirectoryBestEffort(parent.realPath);
    await input.verifySource();
    return identity;
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    let cleanupFailure: { error: unknown } | undefined;
    try {
      if (identity) {
        assertSyncDirectoryGuard(parent);
        const remaining = fs.lstatSync(temporaryPath, { bigint: true, throwIfNoEntry: false });
        if (remaining) {
          inspectFileIdentitySync(() => remaining, identity);
          if (!remaining.isSymbolicLink()) throw new FsSafeError("path-mismatch", "copy link cleanup identity changed");
          if (process.platform === "win32") native!.binding.removeCopyLink!(native!.fd, temporaryName, identity.dev, identity.ino);
          else fs.unlinkSync(temporaryPath);
        }
      }
    } catch (error) {
      cleanupFailure = { error };
    }
    try { await sourceParent?.close(); }
    catch (error) {
      cleanupFailure = { error: cleanupFailure
        ? createSuppressedError(error, cleanupFailure.error, "copy link cleanup and close failed") : error };
    }
    if (cleanupFailure) throw failure
      ? createSuppressedError(cleanupFailure.error, failure.error, "copy link operation and cleanup failed")
      : cleanupFailure.error;
  }
}
