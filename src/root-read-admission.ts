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

function assertRootReadAdmissionCurrent(params: {
  root: RootContext;
  filePath: string;
  handle: FileHandle;
  identity: BigIntStats;
  symlinks?: SymlinkPolicy;
  afterPathIdentityCheck?: (filePath: string, handle: FileHandle) => void;
}): string {
  assertRootIdentityCurrentSync(params.root);
  const admittedPath = (() => {
    try {
      inspectFileIdentitySync(
        () => inspectOpenedPathIdentitySync(params.filePath, params.symlinks),
        params.identity,
      );
      const canonicalPath = realpathSync.native(params.filePath);
      const admittedRealPath = admitPathInsideRoot({
        rootPath: params.root.rootReal,
        candidatePath: canonicalPath,
        rootIdentity: params.root.rootIdentity,
      });
      if (!admittedRealPath) throw outsideWorkspaceError();
      inspectFileIdentitySync(
        () => inspectOpenedPathIdentitySync(canonicalPath, undefined),
        params.identity,
      );
      return admittedRealPath.path;
    } catch (error) {
      throw isNotFoundPathError(error)
        ? openedPathResolutionError(fileNotFoundError())
        : error;
    }
  })();
  params.afterPathIdentityCheck?.(params.filePath, params.handle);
  assertRootIdentityCurrentSync(params.root);
  return admittedPath;
}

type OwnedRootReadHandle = {
  handle: FileHandle;
  realPath: string;
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
}): Promise<T> {
  try {
    if (params.hardlinks !== "allow" && params.opened.stat.nlink > 1) {
      throw hardlinkedPathNotAllowedError();
    }
    const admittedRealPath = admitPathInsideRoot({
      rootPath: params.root.rootReal,
      candidatePath: params.opened.realPath,
      rootIdentity: params.root.rootIdentity,
    });
    if (!admittedRealPath) throw outsideWorkspaceError();
    if (params.beforeFinalFence) {
      await params.beforeFinalFence(params.filePath, params.opened.handle);
    }
    try {
      const finalRealPath = assertRootReadAdmissionCurrent({
        root: params.root,
        filePath: params.filePath,
        handle: params.opened.handle,
        identity: params.identity,
        symlinks: params.symlinks,
        afterPathIdentityCheck: params.afterPathIdentityCheck,
      });
      params.opened.realPath = finalRealPath;
    } catch (error) {
      if (params.identity.nlink <= 1n) {
        await recordOpenedFileFailure(
          error, params.opened.handle, params.filePath, params.identity,
        );
      }
      throw error;
    }
    return params.opened;
  } catch (error) {
    await params.opened.handle.close().catch(() => {});
    throw error;
  }
}
