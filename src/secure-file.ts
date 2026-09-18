import fsSync, { type BigIntStats, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";

import { readFileHandleBounded } from "./bounded-read.js";
import { normalizeMaxBytes } from "./byte-budget.js";
import { assertNoUnsafeDeviceReadPath } from "./device-path.js";
import { resolveEffectiveUid } from "./effective-uid.js";
import { FsSafeError } from "./errors.js";
import { isWindowsDriveLetterPath, isWindowsNetworkPath } from "./local-file-access.js";
import { isPathInside, isSymlinkOpenError } from "./path.js";
import { formatPermissionErrorDetail } from "./permission-exec.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { realpathSync } from "./realpath.js";
import {
  inspectPathPermissions,
  isGroupReadable,
  isGroupWritable,
  isWorldReadable,
  isWorldWritable,
  modeBits,
  type PermissionCheck,
  type PermissionCheckOptions,
} from "./permissions.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { inspectSecureWindowsFile } from "./secure-file-windows.js";
import { scheduleTimeout } from "./timing.js";
import {
  anchorWindowsDriveRelativePath,
  assertNoWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export type SecureFileReadOptions = {
  filePath: string;
  label?: string;
  trust?: SecureFileTrustOptions;
  permissions?: SecureFilePermissionOptions;
  inject?: SecureFileInjectOptions;
  io?: SecureFileIoOptions;
};

export type SecureFileTrustOptions = {
  trustedDirs?: string[];
  allowSymlink?: boolean;
  allowNetworkPath?: boolean;
};

export type SecureFilePermissionOptions = {
  allowInsecure?: boolean;
  allowReadableByOthers?: boolean;
};

export type SecureFileInjectOptions = PermissionCheckOptions;

export type SecureFileIoOptions = {
  maxBytes?: number;
  timeoutMs?: number;
};

export type SecureFileReadResult = {
  buffer: Buffer;
  realPath: string;
  stat: Stats;
  permissions?: PermissionCheck;
};

function snapshotTrustedDirs(dirs: string[] | undefined): string[] | undefined {
  if (dirs === undefined) return undefined;
  if (!Array.isArray(dirs)) {
    throw new FsSafeError("invalid-path", "trustedDirs must be an array of path strings.");
  }
  const trustedDirs: string[] = [];
  const length = dirs.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) {
    throw new FsSafeError("invalid-path", "trustedDirs must have a valid array length.");
  }
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(dirs, index)) {
      throw new FsSafeError("invalid-path", "trustedDirs must not contain sparse entries.");
    }
    const dir = dirs[index];
    if (typeof dir !== "string" || dir.includes("\0")) {
      throw new FsSafeError("invalid-path", "trustedDirs must contain only path strings without null bytes.");
    }
    // Admit the raw suffix before normalization can erase an alternate stream,
    // while retaining Node's per-drive cwd semantics for D:credentials.
    const anchored = anchorWindowsDriveRelativePath(dir);
    assertNoWindowsPathAlias(anchored, "filesystem", "trusted directory uses a Windows filesystem namespace alias");
    const resolved = resolvePathPreservingWindowsRoot(anchored);
    assertNoWindowsPathAlias(resolved, "filesystem", "trusted directory uses a Windows filesystem namespace alias");
    trustedDirs.push(resolved);
  }
  return trustedDirs;
}

function snapshotPermissionEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv | undefined {
  if (env === undefined) return undefined;
  const snapshot = { ...env };
  // Windows command lookup first reads these exact names, even when inherited
  // or non-enumerable, then considers only enumerable own case variants.
  // Reuse copied values so enumerable getters are not invoked a second time.
  if (!Object.hasOwn(snapshot, "SystemRoot")) snapshot.SystemRoot = env.SystemRoot;
  if (!Object.hasOwn(snapshot, "WINDIR")) snapshot.WINDIR = env.WINDIR;
  return snapshot;
}

function snapshotSecureFileOptions(
  options: SecureFileReadOptions,
  io: SecureFileIoOptions | undefined,
  maxBytes: number | undefined,
): SecureFileReadOptions {
  const { filePath, label, trust, permissions, inject } = options;
  const env = inject?.env;
  return {
    filePath,
    label,
    trust: {
      trustedDirs: snapshotTrustedDirs(trust?.trustedDirs),
      allowSymlink: trust?.allowSymlink,
      allowNetworkPath: trust?.allowNetworkPath,
    },
    permissions: {
      allowInsecure: permissions?.allowInsecure,
      allowReadableByOthers: permissions?.allowReadableByOthers,
    },
    inject: {
      platform: inject?.platform,
      env: snapshotPermissionEnv(env),
      exec: inject?.exec,
    },
    io: {
      maxBytes,
      timeoutMs: io?.timeoutMs,
    },
  };
}

function isAbsolutePathname(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    (process.platform === "win32" &&
      (isWindowsDriveLetterPath(value, "win32") || isWindowsNetworkPath(value, "win32")))
  );
}

function label(options: SecureFileReadOptions): string {
  return options.label ?? "Secure file";
}

function assertNotHardlinked(
  options: SecureFileReadOptions,
  stat: Pick<BigIntStats, "nlink">,
): void {
  if (stat.nlink > 1n) {
    throw new FsSafeError("hardlink", `${label(options)} must not be hardlinked: ${options.filePath}`);
  }
}

async function openSecureHandle(options: SecureFileReadOptions, maxBytes: number | undefined): Promise<{
  handle: FileHandle;
  identity: Pick<BigIntStats, "dev" | "ino">;
  pathStat: Stats;
  realPath: string;
}> {
  assertNoUnsafeDeviceReadPath(options.filePath);
  if (isWindowsNetworkPath(options.filePath, "win32") && !options.trust?.allowNetworkPath) {
    throw new FsSafeError("invalid-path", `${label(options)} must be a local absolute path.`);
  }
  if (!isAbsolutePathname(options.filePath)) {
    throw new FsSafeError("invalid-path", `${label(options)} must be an absolute path.`);
  }

  let preStat: Stats;
  try {
    preStat = fsSync.lstatSync(options.filePath);
  } catch (err) {
    throw new FsSafeError("not-found", `${label(options)} is not readable: ${options.filePath}`, {
      cause: err,
    });
  }
  if (preStat.isSymbolicLink()) {
    if (!options.trust?.allowSymlink) {
      throw new FsSafeError("symlink", `${label(options)} must not be a symlink: ${options.filePath}`);
    }
  } else if (!preStat.isFile()) {
    throw new FsSafeError("not-file", `${label(options)} must be a file: ${options.filePath}`);
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(options.filePath, resolveReadOpenFlags({
      followSymlinks: options.trust?.allowSymlink === true,
    }));
  } catch (err) {
    if (isSymlinkOpenError(err)) {
      throw new FsSafeError("symlink", `${label(options)} symlink open blocked`, { cause: err });
    }
    throw err;
  }

  try {
    const openedStat = fsSync.fstatSync(handle.fd);
    if (!openedStat.isFile()) {
      throw new FsSafeError("not-file", `${label(options)} must be a file: ${options.filePath}`);
    }
    const openedIdentity = await inspectFileIdentity(() => fsSync.fstatSync(handle.fd, { bigint: true }));
    assertNotHardlinked(options, openedIdentity);
    await inspectFileIdentity(async () => {
      const pathStat = options.trust?.allowSymlink
        ? fsSync.statSync(options.filePath, { bigint: true })
        : fsSync.lstatSync(options.filePath, { bigint: true });
      if (!options.trust?.allowSymlink && pathStat.isSymbolicLink()) {
        throw new FsSafeError("symlink", `${label(options)} must not be a symlink: ${options.filePath}`);
      }
      assertNotHardlinked(options, pathStat);
      return pathStat;
    }, openedIdentity);
    const realPath = realpathSync.native(options.filePath);
    assertNoWindowsPathAlias(realPath, "filesystem", `${label(options)} resolved path uses a Windows filesystem namespace alias`);
    await inspectFileIdentity(() => {
      const realPathStat = fsSync.statSync(realPath, { bigint: true });
      assertNotHardlinked(options, realPathStat);
      return realPathStat;
    }, openedIdentity);
    if (maxBytes !== undefined && openedStat.size > maxBytes) {
      throw new FsSafeError("too-large", `${label(options)} exceeded maxBytes (${maxBytes}).`);
    }
    return { handle, identity: openedIdentity, pathStat: openedStat, realPath };
  } catch (err) {
    await handle.close().catch(() => undefined);
    throw err;
  }
}

async function assertTrustedDirs(options: SecureFileReadOptions, realPath: string): Promise<void> {
  if (!options.trust?.trustedDirs || options.trust.trustedDirs.length === 0) {
    return;
  }
  const trusted = await Promise.all(
    options.trust.trustedDirs.map(async (dir) => {
      let realPath: string;
      try {
        realPath = realpathSync.native(dir);
      } catch {
        return dir;
      }
      assertNoWindowsPathAlias(realPath, "filesystem", "trusted directory uses a Windows filesystem namespace alias");
      return realPath;
    }),
  );
  if (!trusted.some((dir) => isPathInside(dir, realPath))) {
    throw new FsSafeError("outside-workspace", `${label(options)} is outside trustedDirs: ${realPath}`);
  }
}

function inspectOpenedPermissions(stat: Stats, platform: NodeJS.Platform): PermissionCheck {
  const bits = modeBits(typeof stat.mode === "number" ? stat.mode : null);
  return {
    ok: true,
    isSymlink: false,
    isDir: stat.isDirectory(),
    mode: typeof stat.mode === "number" ? stat.mode : null,
    bits,
    source: platform === "win32" ? "unknown" : "posix",
    worldWritable: isWorldWritable(bits),
    groupWritable: isGroupWritable(bits),
    worldReadable: isWorldReadable(bits),
    groupReadable: isGroupReadable(bits),
  };
}

async function assertSecurePermissions(
  options: SecureFileReadOptions,
  stat: Stats,
  realPath: string,
  identity: Pick<BigIntStats, "dev" | "ino">,
  fd: number,
): Promise<PermissionCheck | undefined> {
  if (options.permissions?.allowInsecure) {
    return undefined;
  }
  const platform = options.inject?.platform ?? process.platform;
  const permissions = platform === "win32"
    ? process.platform === "win32"
      ? await inspectSecureWindowsFile({ fd, identity, stat })
      : await inspectPathPermissions(realPath, options.inject)
    : inspectOpenedPermissions(stat, platform);
  const reason = permissions.error ? `: ${formatPermissionErrorDetail(permissions.error)}` : "";
  const diagnostics = {
    ...(permissions.errorCause !== undefined ? { cause: permissions.errorCause } : {}),
    ...(permissions.ownerError || permissions.errorDetail ? {
      details: {
        ...(permissions.ownerError ? { ownerError: formatPermissionErrorDetail(permissions.ownerError) } : {}),
        ...permissions.errorDetail,
      },
    } : {}),
  };
  if (!permissions.ok) {
    throw new FsSafeError("permission-unverified", `${label(options)} permissions could not be verified: ${realPath}${reason}`, diagnostics);
  }
  if (platform === "win32" && permissions.source === "unknown") {
    throw new FsSafeError(
      "permission-unverified",
      `${label(options)} ACL verification unavailable on Windows for ${realPath}${reason || "."}`,
      diagnostics,
    );
  }
  if (platform === "win32" && permissions.ownerTrusted !== true) {
    throw new FsSafeError(
      permissions.ownerTrusted === false ? "not-owned" : "permission-unverified",
      `${label(options)} owner could not be trusted on Windows: ${realPath}`,
    );
  }
  const writableByOthers = permissions.worldWritable || permissions.groupWritable;
  const readableByOthers = permissions.worldReadable || permissions.groupReadable;
  if (writableByOthers || (!options.permissions?.allowReadableByOthers && readableByOthers)) {
    throw new FsSafeError("insecure-permissions", `${label(options)} permissions are too open: ${realPath}`);
  }
  if (platform !== "win32") {
    let uid: number | undefined;
    try {
      uid = resolveEffectiveUid();
    } catch (cause) {
      throw new FsSafeError(
        "permission-unverified",
        `${label(options)} owner identity could not be verified for the effective user: ${realPath}`,
        { cause },
      );
    }
    if (uid === undefined || !Number.isSafeInteger(stat.uid) || stat.uid < 0) {
      throw new FsSafeError(
        "permission-unverified",
        `${label(options)} owner identity could not be verified for the effective user: ${realPath}`,
      );
    }
    if (stat.uid !== uid) {
      throw new FsSafeError("not-owned", `${label(options)} must be owned by the effective user (uid=${uid}): ${realPath}`);
    }
  }
  return permissions;
}

async function readHandleWithTimeout(
  handle: FileHandle,
  timeoutMs: number | undefined,
  maxBytes: number | undefined,
): Promise<Buffer> {
  const read = () =>
    maxBytes === undefined ? handle.readFile() : readFileHandleBounded(handle, maxBytes);
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return await read();
  }
  let cancelTimeout: (() => void) | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        cancelTimeout = scheduleTimeout(() => {
          void handle.close().catch(() => undefined);
          reject(new FsSafeError("timeout", `secure file read timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    cancelTimeout?.();
  }
}

export async function readSecureFile(
  options: SecureFileReadOptions,
): Promise<SecureFileReadResult> {
  const io = options.io;
  const maxBytes = normalizeMaxBytes(io?.maxBytes);
  options = snapshotSecureFileOptions(options, io, maxBytes);
  assertNoWindowsPathAlias(options.filePath, "filesystem", `${label(options)} path uses a Windows filesystem namespace alias`);
  const opened = await openSecureHandle(options, maxBytes);
  try {
    await assertTrustedDirs(options, opened.realPath);
    const permissions = await assertSecurePermissions(
      options,
      opened.pathStat,
      opened.realPath,
      opened.identity,
      opened.handle.fd,
    );
    const buffer = await readHandleWithTimeout(
      opened.handle,
      options.io?.timeoutMs,
      maxBytes,
    );
    const finalIdentity = await inspectFileIdentity(
      () => fsSync.fstatSync(opened.handle.fd, { bigint: true }),
      opened.identity,
    );
    if (!finalIdentity.isFile()) {
      throw new FsSafeError("not-file", `${label(options)} must remain a file: ${options.filePath}`);
    }
    assertNotHardlinked(options, finalIdentity);
    return { buffer, realPath: opened.realPath, stat: opened.pathStat, permissions };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}
