import fs from "node:fs";
import { isUnsafeDeviceReadPath } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";

export type PinnedOpenSyncFailureReason = "path" | "validation" | "io";

export type PinnedOpenSyncResult =
  | { ok: true; path: string; fd: number; stat: fs.Stats }
  | { ok: false; reason: PinnedOpenSyncFailureReason; error?: unknown };

export type PinnedOpenSyncAllowedType = "file" | "directory";

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
}): PinnedOpenSyncResult {
  const ioFs = params.ioFs ?? fs;
  const allowedType = params.allowedType ?? "file";
  const openReadFlags = resolveReadOpenFlags({ constants: ioFs.constants });
  let fd: number | null = null;
  try {
    if (isUnsafeDeviceReadPath(params.filePath)) {
      return { ok: false, reason: "validation" };
    }
    if (params.rejectPathSymlink) {
      const candidateStat = ioFs.lstatSync(params.filePath);
      if (candidateStat.isSymbolicLink()) {
        return { ok: false, reason: "validation" };
      }
    }

    const realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);
    if (isUnsafeDeviceReadPath(realPath)) {
      return { ok: false, reason: "validation" };
    }
    const preOpenStat = inspectFileIdentitySync(() => {
      const stat = ioFs.lstatSync(realPath, { bigint: true });
      assertAllowedStat(stat, allowedType, params);
      return stat;
    });
    fd = ioFs.openSync(realPath, openReadFlags);
    const openedStat = ioFs.fstatSync(fd);
    const identity = inspectFileIdentitySync(() => {
      const stat = ioFs.fstatSync(fd!, { bigint: true });
      assertAllowedStat(stat, allowedType, params);
      return stat;
    }, preOpenStat);
    inspectFileIdentitySync(() => {
      const stat = ioFs.lstatSync(realPath, { bigint: true });
      assertAllowedStat(stat, allowedType, params);
      return stat;
    }, identity);

    const opened = { ok: true as const, path: realPath, fd, stat: openedStat };
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
      ioFs.closeSync(fd);
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
