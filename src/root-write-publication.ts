import fsSync, { type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { readFileHandleBounded } from "./bounded-read.js";
import type { AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup, sha256Hex } from "./file-identity.js";
import { cleanupPinnedFilePath } from "./replace-file-temp-owner.js";
import type { RootContext } from "./root-context.js";
import type { RootWriteOptions } from "./root-options.js";
import { verifyAtomicWriteResult } from "./root-write-verification.js";

// Compatibility callers hold the lock throughout this operation. The caller
// owns the original write handle; this helper owns a content-verified reopen.
export async function finishRootFallbackWrite(params: {
  root: RootContext;
  targetPath: string;
  handle: FileHandle;
  identity: BigIntStats;
  parentGuard: AnyAsyncDirectoryGuard;
  mode: number;
  options: RootWriteOptions & { data: string | Buffer };
  openForCompatibility: () => Promise<{ opened: { handle: FileHandle }; identity: BigIntStats }>;
  onVerificationFailure: (error: unknown) => void;
}): Promise<void> {
  let handle = params.handle;
  let identity = params.identity;
  let accepted: FileHandle | undefined;
  const compatibility = params.options.renameIdentity === "verify-content-with-lock";
  const verify = async () => {
    try {
      await verifyAtomicWriteResult({
        root: params.root, targetPath: params.targetPath, fd: handle.fd,
        expectedIdentity: identity, parentGuard: params.parentGuard,
      });
    } catch (error) {
      params.onVerificationFailure(error);
      throw error;
    }
  };
  try {
    if (compatibility) {
      const current = fsSync.lstatSync(params.targetPath, { bigint: true });
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new FsSafeError("path-mismatch", "fallback target changed during write");
      }
      if (process.platform === "win32" && (current.dev === 0n || current.ino === 0n)) {
        // Opaque pathname stats are not evidence of rename identity drift. The
        // strict verifier can reopen against the retained descriptor's exact
        // identity without reading bytes; a different object must still fail.
        await verify();
      } else if (!sameFileIdentityForCleanup(current, identity)) {
        const opened = await params.openForCompatibility();
        accepted = handle = opened.opened.handle;
        identity = opened.identity;
        // Admit the destination under the retained Root and parent before any
        // read, chmod, or sync; the original temp no longer proves its identity.
        await verify();
        const data = params.options.data;
        const expectedBytes = typeof data === "string"
          ? Buffer.byteLength(data, params.options.encoding ?? "utf8") : data.byteLength;
        const content = await readFileHandleBounded(handle, expectedBytes).catch((error: unknown) => {
          if (error instanceof FsSafeError && error.code === "too-large") {
            throw new FsSafeError("path-mismatch", "fallback target changed during write", { cause: error });
          }
          throw error;
        });
        if (sha256Hex(content) !== sha256Hex(data, params.options.encoding)) {
          throw new FsSafeError("path-mismatch", "fallback target changed during write");
        }
        await verify();
      }
    }
    // Final mode belongs to the accepted object, including on rename-unstable
    // filesystems; never chmod the old temp and assume its mode was transferred.
    try {
      await handle.chmod(params.mode);
    } catch (error) {
      await cleanupPinnedFilePath({
        pathname: params.targetPath, handle, identity, parentGuard: params.parentGuard,
      });
      throw error;
    }
    if (params.options.durable !== false) await handle.sync();
    await verify();
    if (params.options.durable !== false) {
      await syncDirectoryBestEffort(path.dirname(params.targetPath));
      if (compatibility) await verify();
    }
  } finally {
    await accepted?.close().catch(() => undefined);
  }
}
