import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";

import { readFileHandleBounded } from "./bounded-read.js";
import { assertNoUnsafeDeviceReadPath } from "./device-path.js";
import { FsSafeError } from "./errors.js";
import { isWindowsDriveLetterPath, isWindowsNetworkPath } from "./local-file-access.js";
import { isPathInside, isSymlinkOpenError } from "./path.js";
import { formatPermissionErrorDetail } from "./permission-exec.js";
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

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_READ_FLAGS = fsConstants.O_RDONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

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

async function openSecureHandle(options: SecureFileReadOptions): Promise<{
  handle: FileHandle;
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

  const preStat = await fs.lstat(options.filePath).catch((err: unknown) => {
    throw new FsSafeError("not-found", `${label(options)} is not readable: ${options.filePath}`, {
      cause: err,
    });
  });
  if (preStat.isDirectory()) {
    throw new FsSafeError("not-file", `${label(options)} must be a file: ${options.filePath}`);
  }
  if (preStat.isSymbolicLink() && !options.trust?.allowSymlink) {
    throw new FsSafeError("symlink", `${label(options)} must not be a symlink: ${options.filePath}`);
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(options.filePath, options.trust?.allowSymlink ? fsConstants.O_RDONLY : OPEN_READ_FLAGS);
  } catch (err) {
    if (isSymlinkOpenError(err)) {
      throw new FsSafeError("symlink", `${label(options)} symlink open blocked`, { cause: err });
    }
    throw err;
  }

  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) {
      throw new FsSafeError("not-file", `${label(options)} must be a file: ${options.filePath}`);
    }
    const openedIdentity = await inspectFileIdentity(() => handle.stat({ bigint: true }));
    await inspectFileIdentity(async () => {
      const pathStat = options.trust?.allowSymlink
        ? await fs.stat(options.filePath, { bigint: true })
        : await fs.lstat(options.filePath, { bigint: true });
      if (!options.trust?.allowSymlink && pathStat.isSymbolicLink()) {
        throw new FsSafeError("symlink", `${label(options)} must not be a symlink: ${options.filePath}`);
      }
      return pathStat;
    }, openedIdentity);
    const realPath = await fs.realpath(options.filePath);
    await inspectFileIdentity(() => fs.stat(realPath, { bigint: true }), openedIdentity);
    if (options.io?.maxBytes !== undefined && openedStat.size > options.io.maxBytes) {
      throw new FsSafeError("too-large", `${label(options)} exceeded maxBytes (${options.io.maxBytes}).`);
    }
    return { handle, pathStat: openedStat, realPath };
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
      const resolved = path.resolve(dir);
      return await fs.realpath(resolved).catch(() => resolved);
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
): Promise<PermissionCheck | undefined> {
  if (options.permissions?.allowInsecure) {
    return undefined;
  }
  const platform = options.inject?.platform ?? process.platform;
  const permissions = platform === "win32"
    ? await inspectPathPermissions(realPath, options.inject)
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
  if (platform !== "win32" && typeof process.getuid === "function" && stat.uid != null) {
    const uid = process.getuid();
    if (stat.uid !== uid) {
      throw new FsSafeError("not-owned", `${label(options)} must be owned by the current user (uid=${uid}): ${realPath}`);
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
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void handle.close().catch(() => undefined);
          reject(new FsSafeError("timeout", `secure file read timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function readSecureFile(
  options: SecureFileReadOptions,
): Promise<SecureFileReadResult> {
  const opened = await openSecureHandle(options);
  try {
    await assertTrustedDirs(options, opened.realPath);
    const permissions = await assertSecurePermissions(options, opened.pathStat, opened.realPath);
    const buffer = await readHandleWithTimeout(
      opened.handle,
      options.io?.timeoutMs,
      options.io?.maxBytes,
    );
    return { buffer, realPath: opened.realPath, stat: opened.pathStat, permissions };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}
