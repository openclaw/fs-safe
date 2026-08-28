import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
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
}): Promise<void> {
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
  const assertDescriptor = () => {
    const stat = fsSync.fstatSync(params.fd, { bigint: true });
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
    assertFile(await fs.lstat(params.targetPath, { bigint: true }));
    const realPath = await resolveOpenedFileRealPathForFd(params.fd, stat, params.targetPath);
    assertFile(await fs.stat(realPath, { bigint: true }));
    if (!isPathInside(params.root.rootWithSep, realPath)) {
      throw outsideWorkspaceError();
    }
    await assertAsyncDirectoryGuard(params.parentGuard);
    await assertRootIdentityCurrent(params.root);
    // Recheck after canonical resolution and directory checks, including late links.
    assertFile(await fs.lstat(params.targetPath, { bigint: true }));
    assertDescriptor();
  } catch (error) {
    if (isNotFoundPathError(error)) throw fileNotFoundError();
    throw error;
  }
}
