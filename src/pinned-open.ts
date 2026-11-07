import { numberStats } from "./exact-identity.js";
import fs from "node:fs";
import asyncFs from "node:fs/promises";
import { promisify } from "node:util";
import { runAsync, runSync, wait, type Procedure } from "./atomic-io.js";
import { isUnsafeDeviceReadPath } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { realpathSync } from "./realpath.js";
import type { OwnedFileDescriptorSync } from "./create-owned-file.js";

export type PinnedOpenSyncFailureReason = "path" | "validation" | "io";

export type PinnedOpenSyncResult =
  | { ok: true; path: string; fd: number; stat: fs.Stats; identity: fs.BigIntStats; close?: () => void }
  | { ok: false; reason: PinnedOpenSyncFailureReason; error?: unknown };

export type PinnedOpenSyncAllowedType = "file" | "directory";

export type PinnedOpenSyncFinalAdmission = (params: {
  path: string;
  descriptorIdentity: fs.BigIntStats;
}) => string;

export type PinnedOpenSyncFs = Pick<
  typeof fs,
  "constants" | "lstatSync" | "realpathSync" | "openSync" | "fstatSync" | "closeSync"
>;

const openFd = promisify(fs.open);
const statFd = promisify(fs.fstat);
const closeFd = promisify(fs.close);

export function isExpectedPathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

type PinnedOpenParams = {
  filePath: string;
  resolvedPath?: string;
  rejectPathSymlink?: boolean;
  rejectLeafSymlinks?: boolean;
  rejectHardlinks?: boolean;
  maxBytes?: number;
  allowedType?: PinnedOpenSyncAllowedType;
  ioFs?: PinnedOpenSyncFs;
  admittedFile?: OwnedFileDescriptorSync;
  finalAdmission?: (params: Parameters<PinnedOpenSyncFinalAdmission>[0]) => string | Promise<string>;
};

export function openPinnedFileSync(params: PinnedOpenParams & { finalAdmission?: PinnedOpenSyncFinalAdmission }): PinnedOpenSyncResult {
  return runSync(openPinnedFileProcedure(params, false));
}

export function openPinnedFile(params: PinnedOpenParams): Promise<PinnedOpenSyncResult> {
  return runAsync(openPinnedFileProcedure(params, true));
}

function* openPinnedFileProcedure(params: PinnedOpenParams, asynchronous: boolean): Procedure<PinnedOpenSyncResult> {
  const filePath = params.filePath;
  const resolvedPath = params.resolvedPath;
  const ioFs = params.ioFs ?? fs;
  const allowedType = params.allowedType ?? "file";
  const rejectPathSymlink = params.rejectPathSymlink === true;
  const finalAdmission = params.finalAdmission;
  const statPolicy = {
    rejectHardlinks: params.rejectHardlinks,
    rejectLeafSymlinks: params.rejectLeafSymlinks,
    maxBytes: params.maxBytes,
  };
  const openReadFlags = resolveReadOpenFlags({ constants: ioFs.constants });
  const admittedFile = params.admittedFile;
  let fd: number | null = admittedFile?.fd ?? null;
  try {
    assertNoWindowsPathAlias(filePath, "filesystem", "file path uses a Windows filesystem namespace alias");
    if (resolvedPath !== undefined) {
      assertNoWindowsPathAlias(resolvedPath, "filesystem", "resolved path uses a Windows filesystem namespace alias");
    }
    if (isUnsafeDeviceReadPath(filePath)) {
      return { ok: false, reason: "validation" };
    }
    if (rejectPathSymlink) {
      const candidateStat = asynchronous ? yield* wait(asyncFs.lstat(filePath)) : ioFs.lstatSync(filePath);
      if (candidateStat.isSymbolicLink()) {
        return { ok: false, reason: "validation" };
      }
    }

    const realPath = resolvedPath ?? (asynchronous ? yield* wait(asyncFs.realpath(filePath)) :
      (ioFs === fs ? realpathSync(filePath) : ioFs.realpathSync(filePath)));
    assertNoWindowsPathAlias(realPath, "filesystem", "resolved path uses a Windows filesystem namespace alias");
    if (isUnsafeDeviceReadPath(realPath)) {
      return { ok: false, reason: "validation" };
    }
    const admitStat = (stat: fs.BigIntStats) => {
      assertAllowedStat(stat, allowedType, statPolicy);
      return stat;
    };
    function* inspectPath(expected?: fs.BigIntStats): Procedure<fs.BigIntStats> {
      return asynchronous
        ? yield* wait(inspectFileIdentity(async () => admitStat(await asyncFs.lstat(realPath, { bigint: true })), expected))
        : inspectFileIdentitySync(() => admitStat(ioFs.lstatSync(realPath, { bigint: true })), expected);
    }
    const preOpenStat = yield* inspectPath();
    fd ??= asynchronous ? yield* wait(openFd(realPath, openReadFlags)) : ioFs.openSync(realPath, openReadFlags);
    const identity = asynchronous
      ? yield* wait(inspectFileIdentity(async () => admitStat(await statFd(fd!, { bigint: true })), preOpenStat))
      : inspectFileIdentitySync(() => admitStat(ioFs.fstatSync(fd!, { bigint: true })), preOpenStat);
    yield* inspectPath(identity);

    const admittedPath = finalAdmission ? yield* wait(finalAdmission({
      path: realPath,
      descriptorIdentity: identity,
    })) : realPath;

    const openedStat = numberStats(identity);
    const opened = { ok: true as const, path: admittedPath, fd, stat: openedStat, identity,
      ...(admittedFile ? { close: admittedFile.close } : {}) };
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
        if (admittedFile) admittedFile.close();
        else if (asynchronous) yield* wait(closeFd(fd));
        else ioFs.closeSync(fd);
      } catch {
        // Preserve the failed admission result; success transfers fd above.
      }
    }
  }
}

function assertAllowedStat(
  stat: fs.BigIntStats,
  allowedType: PinnedOpenSyncAllowedType,
  params: { rejectHardlinks?: boolean; rejectLeafSymlinks?: boolean; maxBytes?: number },
): void {
  if (stat.isSymbolicLink() && params.rejectLeafSymlinks) {
    throw new FsSafeError("symlink", "symlink not allowed");
  }
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
