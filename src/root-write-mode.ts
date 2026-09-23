import fsSync from "node:fs";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { realpathSync } from "./realpath.js";
import { hardlinkedPathNotAllowedError } from "./root-errors.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { requirePathInsideRoot, type RootBoundaryIdentity } from "./root-boundary.js";

// The caller has already resolved and guarded this write target.
export async function inheritWriteTargetMode(params: {
  targetPath: string;
  rootWithSep: string;
  rootIdentity?: RootBoundaryIdentity;
  requestedMode?: number;
}): Promise<number> {
  try {
    const admittedTarget = requirePathInsideRoot(
      params.rootWithSep, params.targetPath, params.rootIdentity,
    );
    const targetPath = admittedTarget.path;
    const existing = await inspectFileIdentity(() => fsSync.lstatSync(targetPath, { bigint: true }));
    if (existing.isSymbolicLink()) throw new FsSafeError("path-alias", "path alias escape blocked");
    if (!existing.isFile()) throw new FsSafeError("not-file", "not a file");
    if (existing.nlink > 1n) throw hardlinkedPathNotAllowedError();
    // Preserve read-open admission of the pre-existing destination. access(2)
    // is not equivalent: it ignores ACLs on Windows and capabilities on Linux.
    const handle = await fs.open(targetPath, resolveReadOpenFlags());
    try {
      // Bind admission to the inode whose metadata is inherited.
      await inspectFileIdentity(() => fsSync.fstatSync(handle.fd, { bigint: true }), existing);
    } finally {
      await handle.close().catch(() => undefined);
    }
    try {
      // A parent can change after guarded resolution. Do not inherit metadata
      // from an outside inode, even if the parent is restored before publication.
      const observedRealPath = realpathSync.native(targetPath);
      const admittedRealPath = requirePathInsideRoot(
        params.rootWithSep, observedRealPath, params.rootIdentity,
      );
      const realPath = admittedRealPath.path;
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
