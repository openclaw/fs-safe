import fs from "node:fs";
import { isUnsafeDeviceReadPath } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { realpathSync } from "./realpath.js";

export type PinnedOpenSyncFailureReason = "path" | "validation" | "io";

export type PinnedOpenSyncResult =
  | { ok: true; path: string; fd: number; stat: fs.Stats; identity: fs.BigIntStats }
  | { ok: false; reason: PinnedOpenSyncFailureReason; error?: unknown };

export type PinnedOpenSyncAllowedType = "file" | "directory";

export type PinnedOpenSyncFinalAdmission = (params: {
  path: string;
  preRealpathIdentity: fs.BigIntStats;
  descriptorIdentity: fs.BigIntStats;
}) => string;

export type PinnedOpenSyncFs = Pick<
  typeof fs,
  "constants" | "lstatSync" | "realpathSync" | "openSync" | "fstatSync" | "closeSync"
>;

function isExpectedPathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

export function openPinnedFileSync(params: {
  filePath: string;
  resolvedPath?: string;
  rejectPathSymlink?: boolean;
  rejectHardlinks?: boolean;
  maxBytes?: number;
  allowedType?: PinnedOpenSyncAllowedType;
  ioFs?: PinnedOpenSyncFs;
  finalAdmission?: PinnedOpenSyncFinalAdmission;
}): PinnedOpenSyncResult {
  const filePath = params.filePath;
  const resolvedPath = params.resolvedPath;
  const ioFs = params.ioFs ?? fs;
  const allowedType = params.allowedType ?? "file";
  const rejectPathSymlink = params.rejectPathSymlink === true;
  const statPolicy = {
    rejectHardlinks: params.rejectHardlinks,
    maxBytes: params.maxBytes,
  };
  const openReadFlags = resolveReadOpenFlags({ constants: ioFs.constants });
  let fd: number | null = null;
  try {
    assertNoWindowsPathAlias(filePath, "filesystem", "file path uses a Windows filesystem namespace alias");
    if (resolvedPath !== undefined) {
      assertNoWindowsPathAlias(resolvedPath, "filesystem", "resolved path uses a Windows filesystem namespace alias");
    }
    if (isUnsafeDeviceReadPath(filePath)) {
      return { ok: false, reason: "validation" };
    }
    if (rejectPathSymlink) {
      const candidateStat = ioFs.lstatSync(filePath);
      if (candidateStat.isSymbolicLink()) {
        return { ok: false, reason: "validation" };
      }
    }

    const realPath = resolvedPath ??
      (ioFs === fs ? realpathSync(filePath) : ioFs.realpathSync(filePath));
    assertNoWindowsPathAlias(realPath, "filesystem", "resolved path uses a Windows filesystem namespace alias");
    if (isUnsafeDeviceReadPath(realPath)) {
      return { ok: false, reason: "validation" };
    }
    const preOpenStat = inspectFileIdentitySync(() => {
      const stat = ioFs.lstatSync(realPath, { bigint: true });
      assertAllowedStat(stat, allowedType, statPolicy);
      return stat;
    });
    fd = ioFs.openSync(realPath, openReadFlags);
    const openedStat = ioFs.fstatSync(fd);
    const identity = inspectFileIdentitySync(() => {
      const stat = ioFs.fstatSync(fd!, { bigint: true });
      assertAllowedStat(stat, allowedType, statPolicy);
      return stat;
    }, preOpenStat);
    const pathIdentity = inspectFileIdentitySync(() => {
      const stat = ioFs.lstatSync(realPath, { bigint: true });
      assertAllowedStat(stat, allowedType, statPolicy);
      return stat;
    }, identity);

    const admittedPath = params.finalAdmission?.({
      path: realPath,
      preRealpathIdentity: pathIdentity,
      descriptorIdentity: identity,
    }) ?? realPath;

    const opened = { ok: true as const, path: admittedPath, fd, stat: openedStat, identity };
    fd = null;
    return opened;
  } catch (error) {
    if (error instanceof FsSafeError) return { ok: false, reason: "validation", error };
    if (isExpectedPathError(error)) {
      return { ok: false, reason: "path", error };
    }
    return { ok: false, reason: "io", error };
  } finally {
    if (fd !== null) {
      try {
        ioFs.closeSync(fd);
      } catch {
        // Preserve the failed admission result; success transfers fd above.
      }
    }
  }
}

function assertAllowedStat(
  stat: fs.BigIntStats,
  allowedType: PinnedOpenSyncAllowedType,
  params: { rejectHardlinks?: boolean; maxBytes?: number },
): void {
  if (stat.isSymbolicLink() || !(allowedType === "directory" ? stat.isDirectory() : stat.isFile())) {
    throw new FsSafeError("not-file", "path does not have the required file type");
  }
  if (params.rejectHardlinks && stat.isFile() && stat.nlink > 1n) {
    throw new FsSafeError("hardlink", "path must not be hardlinked");
  }
  if (params.maxBytes !== undefined && stat.isFile() && stat.size > params.maxBytes) {
    throw new FsSafeError("too-large", "file exceeds byte limit");
  }
}
