import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { assertAsyncDirectoryGuard, type AsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { resolveOpenedFileRealPathForFd } from "./opened-realpath.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import type { PublishedWriteIdentity } from "./pinned-write.js";
import { assertRootIdentityCurrent, type RootContext } from "./root-context.js";
import { fileNotFoundError, hardlinkedPathNotAllowedError, outsideWorkspaceError } from "./root-errors.js";

export async function verifyAtomicWriteResult(params: {
  root: RootContext;
  targetPath: string;
  fd: number;
  expectedIdentity: PublishedWriteIdentity;
  parentGuard: AsyncDirectoryGuard;
}, reopenVerified: (
  filePath: string,
  options: { hardlinks: "reject" },
) => Promise<{ handle: FileHandle; realPath: string }>): Promise<void> {
  let needsPathOpen = false;
  const assertFile = (stat: BigIntStats) => {
    if (stat.isSymbolicLink()) {
      throw new FsSafeError("symlink", "symlink not allowed");
    }
    if (!stat.isFile()) {
      throw new FsSafeError("not-file", "not a file");
    }
    if (!sameFileIdentity(stat, params.expectedIdentity)) {
      throw new FsSafeError("path-mismatch", "path changed during write");
    }
    if (stat.nlink > 1) {
      throw hardlinkedPathNotAllowedError();
    }
  };
  const assertPath = (stat: BigIntStats) => {
    assertFile(stat);
    needsPathOpen ||= process.platform === "win32" && (stat.dev === 0n || stat.ino === 0n);
  };
  const assertDescriptor = (fd = params.fd) => {
    const stat = fsSync.fstatSync(fd, { bigint: true });
    // Only Windows pathname stats may have unknown identity; fd stats must match exactly.
    if (params.expectedIdentity.dev !== stat.dev || params.expectedIdentity.ino !== stat.ino) {
      throw new FsSafeError("path-mismatch", "descriptor changed during write");
    }
    assertFile(stat);
    return stat;
  };
  try {
    // This descriptor remains owned by the writer, even when final mode forbids opens.
    const stat = assertDescriptor();
    assertPath(await fs.lstat(params.targetPath, { bigint: true }));
    const realPath = await resolveOpenedFileRealPathForFd(params.fd, stat, params.targetPath);
    assertPath(await fs.stat(realPath, { bigint: true }));
    if (!isPathInside(params.root.rootWithSep, realPath)) {
      throw outsideWorkspaceError();
    }
    await assertAsyncDirectoryGuard(params.parentGuard);
    await assertRootIdentityCurrent(params.root);
    // Recheck after canonical resolution and directory checks, including late links.
    assertPath(await fs.lstat(params.targetPath, { bigint: true }));
    assertDescriptor();
    if (needsPathOpen) {
      // A retained fd cannot prove that an opaque Windows pathname still names it.
      // Keep the guarded reader fallback; POSIX no-read modes never take this path.
      const opened = await reopenVerified(params.targetPath, { hardlinks: "reject" });
      try {
        if (!isPathInside(params.root.rootWithSep, opened.realPath)) {
          throw outsideWorkspaceError();
        }
        await assertAsyncDirectoryGuard(params.parentGuard);
        await assertRootIdentityCurrent(params.root);
        assertDescriptor(opened.handle.fd);
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    }
  } catch (error) {
    if (isNotFoundPathError(error)) throw fileNotFoundError();
    throw error;
  }
}
