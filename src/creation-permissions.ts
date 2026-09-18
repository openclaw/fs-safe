import type { BigIntStats } from "node:fs";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import {
  inspectWindowsDirectoryCommand,
  inspectWindowsDirectoryCommandSync,
  protectPrivateWindowsFileCommand,
  protectPrivateWindowsFileCommandSync,
  verifyPrivateWindowsFileCommand,
  verifyPrivateWindowsFileCommandSync,
} from "./windows-security-command.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

export type CreationPermissions = { private?: boolean; mode?: number };

export function resolveCreationPermissions(
  options: CreationPermissions,
  directory: boolean,
): { private: boolean; mode: number | undefined } {
  const privatePath = options.private;
  const mode = options.mode;
  if (privatePath !== undefined && typeof privatePath !== "boolean") {
    throw new TypeError("private must be a boolean");
  }
  if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o7777)) {
    throw new RangeError("mode must contain only permission bits");
  }
  if (privatePath && mode !== undefined && (mode & 0o7077) !== 0) {
    throw new FsSafeError("insecure-permissions", "private creation requires owner-only permission bits");
  }
  return { private: privatePath === true, mode: mode ?? (privatePath ? directory ? 0o700 : 0o600 : undefined) };
}

function assertPrivatePosixDirectory(stat: BigIntStats): void {
  if (typeof process.getuid !== "function" || stat.uid !== BigInt(process.getuid())) {
    throw new FsSafeError("not-owned", "private directory must belong to the current user");
  }
  if ((stat.mode & 0o7077n) !== 0n) {
    throw new FsSafeError("insecure-permissions", "existing directory is not private");
  }
}

function unavailable(): never {
  throw new FsSafeError("helper-unavailable", "private Windows creation requires an up-to-date native helper");
}

export function assertPrivateFileCreationAvailable(): void {
  const native = getNativeBinding();
  if (process.platform !== "win32" || getFsSafeNativeConfig().mode !== "require") return;
  if (typeof native?.createPrivateDirectoryWithParentIdentity !== "function" ||
    typeof native.inspectWindowsDirectory !== "function" ||
    typeof native.protectPrivateWindowsFile !== "function" ||
    typeof native.verifyPrivateWindowsFile !== "function") unavailable();
}

function commandFallback(): void {
  if (getFsSafeNativeConfig().mode === "require") unavailable();
  warnNativeFallback("windows-private-creation", "Private Windows creation uses a slower built-in system command.");
}

/** Full Windows identity, with security validation when requested; no repairs. */
export function inspectCreationDirectorySync(targetPath: string, privatePath: boolean): string {
  assertNoWindowsPathAlias(targetPath, "filesystem");
  const native = getNativeBinding();
  if (typeof native?.inspectWindowsDirectory === "function") {
    return native.inspectWindowsDirectory(targetPath, privatePath).identity;
  }
  commandFallback();
  return inspectWindowsDirectoryCommandSync(targetPath, privatePath).identity;
}

export async function inspectCreationDirectory(targetPath: string, privatePath: boolean): Promise<string> {
  assertNoWindowsPathAlias(targetPath, "filesystem");
  const native = getNativeBinding();
  if (typeof native?.inspectWindowsDirectory === "function") {
    return native.inspectWindowsDirectory(targetPath, privatePath).identity;
  }
  commandFallback();
  return (await inspectWindowsDirectoryCommand(targetPath, privatePath)).identity;
}

export function assertPrivateDirectorySync(targetPath: string): void {
  const stat = inspectDirectoryIdentitySync(targetPath);
  if (process.platform === "win32") inspectCreationDirectorySync(targetPath, true);
  else assertPrivatePosixDirectory(stat);
  inspectDirectoryIdentitySync(targetPath, stat);
}

export async function assertPrivateDirectory(targetPath: string): Promise<void> {
  const stat = inspectDirectoryIdentitySync(targetPath);
  if (process.platform === "win32") await inspectCreationDirectory(targetPath, true);
  else assertPrivatePosixDirectory(stat);
  inspectDirectoryIdentitySync(targetPath, stat);
}

export function protectCreatedFileSync(fd: number, targetPath: string, parentIdentity: string): string {
  const native = getNativeBinding();
  if (typeof native?.protectPrivateWindowsFile === "function") {
    return native.protectPrivateWindowsFile(fd, targetPath, parentIdentity).identity;
  }
  commandFallback();
  return protectPrivateWindowsFileCommandSync(fd, targetPath, parentIdentity).identity;
}

export async function protectCreatedFile(fd: number, targetPath: string, parentIdentity: string): Promise<string> {
  const native = getNativeBinding();
  if (typeof native?.protectPrivateWindowsFile === "function") {
    return native.protectPrivateWindowsFile(fd, targetPath, parentIdentity).identity;
  }
  commandFallback();
  return (await protectPrivateWindowsFileCommand(fd, targetPath, parentIdentity)).identity;
}

export function verifyCreatedFileSync(
  fd: number, targetPath: string, identity: string, parentIdentity: string, links = 1,
): void {
  const native = getNativeBinding();
  if (typeof native?.verifyPrivateWindowsFile === "function") {
    native.verifyPrivateWindowsFile(fd, targetPath, identity, parentIdentity, links);
    return;
  }
  commandFallback();
  verifyPrivateWindowsFileCommandSync(fd, targetPath, identity, parentIdentity, links);
}

export async function verifyCreatedFile(
  fd: number, targetPath: string, identity: string, parentIdentity: string, links = 1,
): Promise<void> {
  const native = getNativeBinding();
  if (typeof native?.verifyPrivateWindowsFile === "function") {
    native.verifyPrivateWindowsFile(fd, targetPath, identity, parentIdentity, links);
    return;
  }
  commandFallback();
  await verifyPrivateWindowsFileCommand(fd, targetPath, identity, parentIdentity, links);
}
