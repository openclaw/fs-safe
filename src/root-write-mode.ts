import fsSync from "node:fs";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { isNotFoundPathError, isPathInside } from "./path.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { hardlinkedPathNotAllowedError, outsideWorkspaceError } from "./root-errors.js";
import { inspectFileIdentity } from "./strict-file-identity.js";

// The caller has already resolved and guarded this write target.
export async function inheritWriteTargetMode(params: {
  targetPath: string;
  rootWithSep: string;
  requestedMode?: number;
}): Promise<number> {
  try {
    const existing = await inspectFileIdentity(() => fsSync.lstatSync(params.targetPath, { bigint: true }));
    if (existing.isSymbolicLink()) throw new FsSafeError("path-alias", "path alias escape blocked");
    if (!existing.isFile()) throw new FsSafeError("not-file", "not a file");
    if (existing.nlink > 1n) throw hardlinkedPathNotAllowedError();
    if (!isPathInside(params.rootWithSep, params.targetPath)) throw outsideWorkspaceError();
    // Preserve read-open admission of the pre-existing destination. access(2)
    // is not equivalent: it ignores ACLs on Windows and capabilities on Linux.
    const handle = await fs.open(params.targetPath, resolveReadOpenFlags());
    try {
      // Bind admission to the inode whose metadata is inherited.
      if (!sameFileIdentity(fsSync.fstatSync(handle.fd, { bigint: true }), existing)) {
        throw new FsSafeError("path-mismatch", "write target changed during mode inheritance");
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    try {
      // A parent can change after guarded resolution. Do not inherit metadata
      // from an outside inode, even if the parent is restored before publication.
      const realPath = fsSync.realpathSync(params.targetPath);
      if (!isPathInside(params.rootWithSep, realPath)) throw outsideWorkspaceError();
      await inspectFileIdentity(async () => {
        const current = fsSync.statSync(realPath, { bigint: true });
        if (!current.isFile()) throw new FsSafeError("not-file", "not a file");
        if (current.nlink > 1n) throw hardlinkedPathNotAllowedError();
        return current;
      }, existing);
    } catch (error) {
      if (isNotFoundPathError(error)) {
        throw new FsSafeError("path-mismatch", "write target changed during mode inheritance", { cause: error });
      }
      throw error;
    }
    return params.requestedMode ?? Number(existing.mode & 0o777n);
  } catch (error) {
    if (!isNotFoundPathError(error)) throw error;
    return params.requestedMode ?? 0o600;
  }
}
