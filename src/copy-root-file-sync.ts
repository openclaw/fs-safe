import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { normalizeMaxBytes } from "./byte-budget.js";
import { createCopyPathAdmissionCache, type CopyPath } from "./copy-path-admission.js";
import { resolveCopyCloneMode, type CopyCloneMode } from "./copy-policy.js";
import { createFileWithAdmissionSync } from "./create.js";
import { ownFileDescriptorSync, type OwnedFileDescriptorSync } from "./create-owned-file.js";
import { creationAdmissionFromParent, removeRecordedCreationFileSync } from "./creation-boundary.js";
import { FsSafeError } from "./errors.js";
import { assertExclusiveCreateLeaf } from "./exclusive-create.js";
import { copyFileDescriptorSync } from "./file-handle-transfer.js";
import { captureNativeFdClose, type NativeFileCopyResult } from "./native-binding.js";
import { getNativeBinding } from "./native.js";
import { openRootFileSync } from "./root-file.js";
import { inspectOpenedPathIdentitySync } from "./root-read-admission.js";
import { openStagedDirectory } from "./staged-directory.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

export type CopyRootFileSyncOptions = {
  source: CopyPath;
  destination: CopyPath;
  expectedSourceIdentity?: { dev: bigint; ino: bigint };
  clone?: CopyCloneMode;
  maxBytes?: number;
  mode?: number;
  preserveSourceMode?: boolean;
  sourceHardlinks?: "reject" | "allow";
};

export type CopiedRootFileSync = OwnedFileDescriptorSync & Readonly<{
  path: string;
  bytes: number;
  method: "clone" | "copy-file-range" | "copy";
  identity: Readonly<{ dev: bigint; ino: bigint }>;
  sourceIdentity: Readonly<{ dev: bigint; ino: bigint }>;
}>;

function copyError(error: unknown): FsSafeError {
  if (error instanceof FsSafeError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new FsSafeError(
    code === "EEXIST" ? "already-exists" : code === "ENOENT" ? "not-found" :
      code === "too-large" ? "too-large" :
        ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL"].includes(code ?? "")
          ? "unsupported-platform" : "helper-failed",
    "guarded synchronous file copy failed", { cause: error },
  );
}

/** Exclusively copies an admitted source and transfers the owned destination fd. */
export function copyRootFileSync(options: CopyRootFileSyncOptions): CopiedRootFileSync {
  return copyRootFileWithAdmissionSync(options, createCopyPathAdmissionCache());
}

export type RootFileCopyBatchSync = {
  copyFile(options: CopyRootFileSyncOptions): CopiedRootFileSync;
  close(): void;
  [Symbol.dispose](): void;
};

/** Reuses directory admissions while retaining fresh checks for every copy. */
export function createRootFileCopyBatchSync(): RootFileCopyBatchSync {
  const cache = createCopyPathAdmissionCache();
  let closed = false;
  const close = () => { closed = true; cache.clear(); };
  return Object.freeze({
    copyFile(options: CopyRootFileSyncOptions) {
      if (closed) throw new FsSafeError("invalid-path", "copy batch is closed");
      return copyRootFileWithAdmissionSync(options, cache);
    },
    close,
    [Symbol.dispose]: close,
  });
}

function copyRootFileWithAdmissionSync(
  options: CopyRootFileSyncOptions,
  cache: ReturnType<typeof createCopyPathAdmissionCache>,
): CopiedRootFileSync {
  // Snapshot caller options before the first filesystem observation.
  const sourceInput = options.source;
  const sourcePath = { rootPath: sourceInput.rootPath, absolutePath: sourceInput.absolutePath };
  const targetInput = options.destination;
  const targetPath = { rootPath: targetInput.rootPath, absolutePath: targetInput.absolutePath };
  const expectedInput = options.expectedSourceIdentity;
  const expectedSourceIdentity = expectedInput === undefined ? undefined : { dev: expectedInput.dev, ino: expectedInput.ino };
  const clone = resolveCopyCloneMode(options.clone, "never");
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const mode = options.mode;
  const preserveSourceMode = options.preserveSourceMode;
  const sourceHardlinks = options.sourceHardlinks ?? "reject";
  if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o777)) {
    throw new FsSafeError("invalid-path", "copy mode must be an integer from 0 to 0o777");
  }
  if (sourceHardlinks !== "allow" && sourceHardlinks !== "reject") {
    throw new FsSafeError("invalid-path", "invalid copy source hardlink policy");
  }
  let sourceOwner: OwnedFileDescriptorSync | undefined;
  let targetOwner: OwnedFileDescriptorSync | undefined;
  let parentOwner: OwnedFileDescriptorSync | undefined;
  let parentOpen = false;
  let target: ReturnType<typeof cache.admit> | undefined;
  let identity: BigIntStats | undefined;
  const native = process.platform !== "win32" ? getNativeBinding("copyFileExclusiveSync", "removeStagedFile") : getNativeBinding();
  const nativeCopy = process.platform !== "win32" && native?.copyFileExclusiveSync && native.removeStagedFile
    ? native.copyFileExclusiveSync.bind(native) : undefined;
  try {
    const source = cache.admit(sourcePath);
    target = cache.admit(targetPath, true);
    // Preserve exclusive-create collision semantics for dangling Windows leaves.
    assertExclusiveCreateLeaf(targetPath.absolutePath);
    if (fs.lstatSync(target.path, { throwIfNoEntry: false })) {
      throw new FsSafeError("already-exists", "copy destination already exists");
    }
    const opened = openRootFileSync({
      ...sourcePath, rootRealPath: source.rootCanonicalPath, boundaryLabel: "copy source", maxBytes,
      rejectHardlinks: sourceHardlinks !== "allow",
    });
    if (!opened.ok) throw opened.error ?? new FsSafeError("helper-failed", "copy source admission failed");
    sourceOwner = ownFileDescriptorSync(opened.fd);
    const sourceIdentity = inspectFileIdentitySync(() => fs.fstatSync(opened.fd, { bigint: true }), expectedSourceIdentity);
    const verifySource = () => {
      source.assertCurrent();
      for (const inspect of [
        () => fs.fstatSync(opened.fd, { bigint: true }),
        () => inspectOpenedPathIdentitySync(source.path, undefined),
      ]) {
        const current = inspectFileIdentitySync(inspect, sourceIdentity);
        if (!current.isFile()) throw new FsSafeError("not-file", "copy source must be a regular file");
        if (sourceHardlinks !== "allow" && current.nlink > 1n) {
          throw new FsSafeError("hardlink", "copy source must not be hardlinked");
        }
      }
    };
    const selectedMode = mode ?? (preserveSourceMode ? Number(sourceIdentity.mode & 0o777n) : 0o600 & ~process.umask());
    let copied: NativeFileCopyResult | undefined;
    verifySource();
    target.assertCurrent();
    if (nativeCopy) {
      const closeNative = captureNativeFdClose(native!);
      const parent = openStagedDirectory(target.parent.realPath);
      parentOwner = ownFileDescriptorSync(parent.fd);
      parentOpen = true;
      inspectFileIdentitySync(() => fs.fstatSync(parent.fd, { bigint: true }), { dev: BigInt(target.parent.stat.dev), ino: BigInt(target.parent.stat.ino) });
      target.assertCurrent();
      copied = nativeCopy(opened.fd, parent.fd, path.basename(target.path), clone,
        maxBytes !== undefined && Number.isFinite(maxBytes) ? maxBytes : undefined);
      targetOwner = ownFileDescriptorSync(copied.fd, closeNative);
    } else {
      if (clone === "always") throw new FsSafeError("unsupported-platform", "synchronous native file cloning is unavailable");
      targetOwner = createFileWithAdmissionSync(target.path,
        { mode: 0o600, assertBeforeMutation: target.assertCurrent }, creationAdmissionFromParent(target.parent));
    }
    identity = inspectFileIdentitySync(() => fs.fstatSync(targetOwner!.fd, { bigint: true }));
    const verifyTarget = () => {
      target!.assertCurrent();
      const current = inspectFileIdentitySync(() => fs.fstatSync(targetOwner!.fd, { bigint: true }), identity);
      const named = inspectFileIdentitySync(() => inspectOpenedPathIdentitySync(target!.path, undefined), identity);
      if (!current.isFile() || current.nlink !== 1n || !named.isFile() || named.nlink !== 1n) {
        throw new FsSafeError("path-mismatch", "copy destination changed");
      }
      return current;
    };
    verifyTarget();
    if (copied?.errorCode) {
      throw copyError(Object.assign(new Error(copied.errorMessage), { code: copied.errorCode }));
    }
    const method = copied ? copied.method : "copy";
    if (method !== "clone" && method !== "copy-file-range" && method !== "copy") {
      throw new FsSafeError("helper-failed", "native copy returned an unknown method");
    }
    if (!copied) {
      copyFileDescriptorSync(opened.fd, targetOwner.fd, { maxBytes });
    }
    verifySource();
    const completed = verifyTarget();
    if (maxBytes !== undefined && Number.isFinite(maxBytes) && completed.size > BigInt(maxBytes)) {
      throw new FsSafeError("too-large", "copy exceeds maxBytes");
    }
    fs.fchmodSync(targetOwner.fd, selectedMode);
    verifySource();
    verifyTarget();
    sourceOwner.close();
    parentOpen = false;
    parentOwner?.close();
    return Object.freeze({
      ...targetOwner, path: target.path, bytes: Number(completed.size), method,
      identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
      sourceIdentity: Object.freeze({ dev: sourceIdentity.dev, ino: sourceIdentity.ino }),
    });
  } catch (error) {
    const primary = copyError(error);
    const cleanup: unknown[] = [];
    if (targetOwner && target) {
      try {
        if (parentOpen) {
          const removed = native!.removeStagedFile!(parentOwner!.fd, path.basename(target.path), targetOwner.fd);
          if (removed === "preserved") throw new FsSafeError("path-mismatch", "copy cleanup preserved a replacement");
        } else if (identity) {
          removeRecordedCreationFileSync(target.path, identity, target.assertCurrent);
        }
      } catch (failure) { cleanup.push(failure); }
    }
    for (const owner of [targetOwner, sourceOwner, parentOwner]) {
      try { owner?.close(); } catch (failure) { cleanup.push(failure); }
    }
    if (cleanup.length) {
      throw new FsSafeError(primary.code, primary.message, {
        cause: new AggregateError([primary, ...cleanup], "copy and cleanup failed"),
        details: { path: target?.path, cleanup: "failed" },
      });
    }
    throw primary;
  }
}
