import fsSync, { type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { recordOpenedFileFailure } from "./opened-file-failure.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { assertRootIdentityCurrentSync, type RootContext } from "./root-context.js";
import { hardlinkedPathNotAllowedError, outsideWorkspaceError } from "./root-errors.js";
import type { HardlinkPolicy } from "./root-options.js";
import type { SymlinkPolicy } from "./root-symlink-policy.js";

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
  admittedPath: string;
  afterPathIdentityCheck?: (filePath: string, handle: FileHandle) => void;
}): string {
  assertRootIdentityCurrentSync(params.root);
  // Intentional proof mutation: retain the root/root fence and hook order, but
  // bypass the coupled final pathname/canonical identity admission.
  params.afterPathIdentityCheck?.(params.filePath, params.handle);
  assertRootIdentityCurrentSync(params.root);
  return params.admittedPath;
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
        admittedPath: admittedRealPath.path,
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
