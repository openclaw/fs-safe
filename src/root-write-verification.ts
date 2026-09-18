import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { assertAsyncDirectoryGuard, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { resolveOpenedFileRealPathForFd } from "./opened-realpath.js";
import { assertNoUnsafeDeviceReadPath, hasNodeErrorCode, isNotFoundPathError, isSymlinkOpenError } from "./path.js";
import type { PublishedWriteIdentity } from "./pinned-write.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { assertRootIdentityCurrent, type RootContext } from "./root-context.js";
import { fileNotFoundError, hardlinkedPathNotAllowedError, outsideWorkspaceError } from "./root-errors.js";
import { admitPathInsideRoot } from "./root-boundary.js";

export async function verifyAtomicWriteResult(params: {
  root: RootContext;
  targetPath: string;
  fd: number;
  expectedIdentity: PublishedWriteIdentity;
  expectedMode?: number;
  parentGuard: AnyAsyncDirectoryGuard;
}): Promise<void> {
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
    if (process.platform !== "win32" && params.expectedMode !== undefined) {
      const actualMode = Number(stat.mode & 0o7777n);
      if (actualMode !== params.expectedMode) {
        throw new Error(
          `Private secret file ${params.targetPath} has insecure permissions ${actualMode.toString(8)}.`,
        );
      }
    }
    return stat;
  };
  try {
    let opened: FileHandle | undefined;
    try {
      while (true) {
        // The original descriptor remains borrowed; only a verification reopen is owned here.
        const fd = opened?.fd ?? params.fd;
        const stat = assertDescriptor(fd);
        assertPath(fsSync.lstatSync(params.targetPath, { bigint: true }));
        const { realPath, stat: resolvedStat } = await resolveOpenedFileRealPathForFd(fd, stat, params.targetPath);
        // Consume the resolver's observation only in this pass; the checks after
        // the directory guards must still sample the current path and descriptor.
        assertPath(resolvedStat);
        if (!admitPathInsideRoot({
          rootPath: params.root.rootReal,
          candidatePath: realPath,
          rootIdentity: params.root.rootIdentity,
        })) {
          throw outsideWorkspaceError();
        }
        await assertAsyncDirectoryGuard(params.parentGuard);
        await assertRootIdentityCurrent(params.root);
        // Recheck after canonical resolution and directory checks, including late links.
        assertPath(fsSync.lstatSync(params.targetPath, { bigint: true }));
        assertDescriptor(fd);
        if (opened || !needsPathOpen) break;
        // Opaque Windows pathname identity needs one independent, read-free reopen.
        assertNoUnsafeDeviceReadPath(params.targetPath);
        opened = await fs.open(params.targetPath, resolveReadOpenFlags()).catch((error: unknown) => {
          if (isSymlinkOpenError(error)) {
            throw new FsSafeError("symlink", "symlink open blocked", { cause: error });
          }
          if (hasNodeErrorCode(error, "EISDIR")) throw new FsSafeError("not-file", "not a file");
          throw error;
        });
      }
    } finally {
      if (opened) await opened.close().catch(() => undefined);
    }
  } catch (error) {
    if (isNotFoundPathError(error)) throw fileNotFoundError();
    throw error;
  }
}
