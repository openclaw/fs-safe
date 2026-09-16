import fs, { type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { resolveCopyCloneMode, type CopyCloneMode } from "./copy-policy.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding, type NativeBinding } from "./native.js";
import { captureNativeFdClose, type NativeFileCopyResult } from "./native-binding.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { transferFileHandle } from "./file-handle-transfer.js";

export type CopyFileInput = {
  kind: "file";
  handle: FileHandle;
  size: number;
  clone: CopyCloneMode;
  signal?: AbortSignal;
  verifySource(): Promise<void>;
};

export function resolveFileCopyCloneMode(mode?: CopyCloneMode): CopyCloneMode {
  const clone = resolveCopyCloneMode(mode, "never");
  if (clone === "always" && !getNativeBinding()?.copyFileExclusive) {
    throw new FsSafeError("helper-unavailable", "native file cloning is unavailable");
  }
  return clone;
}

export async function assertCopySourceCurrent(
  source: { handle: FileHandle; realPath: string },
  identity: BigIntStats,
): Promise<void> {
  await inspectFileIdentity(() => fs.fstatSync(source.handle.fd, { bigint: true }), identity);
  await inspectFileIdentity(() => {
    const current = fs.lstatSync(source.realPath, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new FsSafeError("path-mismatch", "copy source path changed");
    }
    return current;
  }, identity);
}

export async function writeCopyFileToFd(
  fd: number,
  input: CopyFileInput,
  maxBytes?: number,
  assertBeforeMutation?: () => void,
): Promise<void> {
  await transferFileHandle(input.handle, fd, {
    maxBytes, sizeHint: input.size, signal: input.signal, assertBeforeMutation,
  });
}

export async function createNativeCopyFile(
  native: NativeBinding,
  input: CopyFileInput,
  parentFd: number,
  basename: string,
  maxBytes: number | undefined,
  sync: boolean,
): Promise<NativeFileCopyResult | undefined> {
  input.signal?.throwIfAborted();
  if (!native.copyFileExclusive) {
    if (input.clone === "always") {
      throw new FsSafeError("helper-unavailable", "native file cloning is unavailable");
    }
    return undefined;
  }
  captureNativeFdClose(native);
  const nativeSignal = input.signal ? AbortSignal.any([input.signal]) : undefined;
  try {
    // The caller adopts this descriptor before observing a later cancellation.
    return await native.copyFileExclusive(
      input.handle.fd, parentFd, basename, input.clone,
      maxBytes !== undefined && Number.isFinite(maxBytes) ? maxBytes : undefined,
      nativeSignal, sync,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "Cancelled" || code === "ABORT_ERR") input.signal?.throwIfAborted();
    if (code === "too-large") {
      throw new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes`, { cause: error });
    }
    if (code === "ENOTSUP" && input.clone !== "always") return undefined;
    if (code === "ENOTSUP") {
      throw new FsSafeError("unsupported-platform", "native file cloning is unsupported", { cause: error });
    }
    throw new FsSafeError("helper-failed", "native file copy failed", { cause: error });
  } finally {
    if (nativeSignal) nativeSignal.onabort = null;
  }
}

export function assertNativeCopyCompleted(input: CopyFileInput, copied?: NativeFileCopyResult): void {
  if (copied?.errorCode) {
    if (copied.errorCode === "Cancelled" || copied.errorCode === "ABORT_ERR") input.signal?.throwIfAborted();
    const unsupported = ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL"].includes(copied.errorCode);
    throw new FsSafeError(
      copied.errorCode === "too-large" ? "too-large" : unsupported ? "unsupported-platform" : "helper-failed",
      copied.errorMessage ?? "native file copy failed",
      { cause: Object.assign(new Error(copied.errorMessage ?? "native file copy failed"), { code: copied.errorCode }) },
    );
  }
  input.signal?.throwIfAborted();
}
