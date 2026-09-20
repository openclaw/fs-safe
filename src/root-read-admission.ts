import fsSync, { type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { openedPathResolutionError, recordOpenedFileFailure } from "./opened-file-failure.js";
import { isNotFoundPathError } from "./path.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { assertRootIdentityCurrentSync, type RootContext } from "./root-context.js";
import { fileNotFoundError, hardlinkedPathNotAllowedError, outsideWorkspaceError } from "./root-errors.js";
import type { HardlinkPolicy } from "./root-options.js";
import type { SymlinkPolicy } from "./root-symlink-policy.js";
import { realpathSync } from "./realpath.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

function resolveFinalOpenedRealPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch (error) {
    // Windows can report a deleted-but-open file through either resolver
    // failure. Only the same-descriptor unlink proof may consume this receipt.
    if (process.platform === "win32" && error instanceof Error &&
      ["EPERM", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw openedPathResolutionError(error);
    }
    throw error;
  }
}

export function inspectOpenedPathIdentitySync(
  filePath: string,
  symlinks: SymlinkPolicy | undefined,
): BigIntStats {
  const stat = symlinks === "follow-within-root"
    ? fsSync.statSync(filePath, { bigint: true })
    : fsSync.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink() && symlinks !== "follow-within-root") {
    throw new FsSafeError("symlink", "symlink not allowed");
  }
  return stat;
}

type OwnedRootReadHandle = {
  handle: FileHandle;
  stat: { nlink: number };
};

export async function admitRootReadHandle<T extends OwnedRootReadHandle>(params: {
  root: RootContext;
  filePath: string;
  opened: T;
  identity: BigIntStats;
  hardlinks?: HardlinkPolicy;
  symlinks?: SymlinkPolicy;
  beforeFinalFence?: (filePath: string, handle: FileHandle) => Promise<void> | void;
  afterPathIdentityCheck?: (filePath: string, handle: FileHandle) => void;
}): Promise<T & { realPath: string }> {
  try {
    if (params.hardlinks !== "allow" && params.opened.stat.nlink > 1) {
      throw hardlinkedPathNotAllowedError();
    }
    if (params.beforeFinalFence) {
      await params.beforeFinalFence(params.filePath, params.opened.handle);
    }
    try {
      assertRootIdentityCurrentSync(params.root);
      let realPath: string;
      try {
        const current = inspectFileIdentitySync(
          () => inspectOpenedPathIdentitySync(params.filePath, params.symlinks),
          params.identity,
        );
        if (params.hardlinks !== "allow" && current.nlink > 1n) throw hardlinkedPathNotAllowedError();
        const canonicalPath = resolveFinalOpenedRealPath(params.filePath);
        assertNoWindowsPathAlias(canonicalPath, "filesystem", "resolved file path uses a Windows filesystem namespace alias");
        const admittedRealPath = admitPathInsideRoot({
          rootPath: params.root.rootReal,
          candidatePath: canonicalPath,
          rootIdentity: params.root.rootIdentity,
        });
        if (!admittedRealPath) {
          throw openedPathResolutionError(outsideWorkspaceError());
        }
        // This is a fresh no-follow observation even when canonicalPath and
        // filePath have the same spelling; realpath may have raced a replacement.
        const canonical = inspectFileIdentitySync(
          () => inspectOpenedPathIdentitySync(canonicalPath, undefined),
          params.identity,
        );
        if (params.hardlinks !== "allow" && canonical.nlink > 1n) throw hardlinkedPathNotAllowedError();
        realPath = admittedRealPath.path;
      } catch (error) {
        throw isNotFoundPathError(error)
          ? openedPathResolutionError(fileNotFoundError())
          : error;
      }
      params.afterPathIdentityCheck?.(params.filePath, params.opened.handle);
      assertRootIdentityCurrentSync(params.root);
      return { ...params.opened, realPath };
    } catch (error) {
      if (params.identity.nlink <= 1n) {
        await recordOpenedFileFailure(
          error, params.opened.handle, params.filePath, params.identity,
        );
      }
      throw error;
    }
  } catch (error) {
    await params.opened.handle.close().catch(() => {});
    throw error;
  }
}
