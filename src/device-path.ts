import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isFileUrl, trySafeFileURLToPath } from "./local-file-access.js";

export type UnsafeDeviceReadPathReason =
  | "posix-device"
  | "posix-fd"
  | "windows-device";

export type UnsafeDeviceReadPathMatch = {
  path: string;
  reason: UnsafeDeviceReadPathReason;
};

export type UnsafeDeviceReadPathOptions = {
  cwd?: string;
  platform?: NodeJS.Platform;
};

const POSIX_BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/console",
]);

export const WINDOWS_RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CLOCK$",
  "CONIN$",
  "CONOUT$",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "COM¹",
  "COM²",
  "COM³",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
  "LPT¹",
  "LPT²",
  "LPT³",
]);

const WINDOWS_SEPARATOR_CHAR_CODE = 0x5c;
const WINDOWS_IGNORED_SPACE_CHAR_CODE = 0x20;
const WINDOWS_IGNORED_DOT_CHAR_CODE = 0x2e;

function trimTrailingWindowsSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === WINDOWS_SEPARATOR_CHAR_CODE) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function trimTrailingWindowsIgnoredChars(value: string): string {
  let end = value.length;
  while (end > 0) {
    const charCode = value.charCodeAt(end - 1);
    if (
      charCode !== WINDOWS_IGNORED_SPACE_CHAR_CODE &&
      charCode !== WINDOWS_IGNORED_DOT_CHAR_CODE
    ) {
      break;
    }
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function candidateReadPaths(filePath: string, platform: NodeJS.Platform): string[] {
  if (!isFileUrl(filePath)) {
    return [filePath];
  }
  const parsed = trySafeFileURLToPath(filePath, platform);
  return parsed === undefined ? [filePath] : [filePath, parsed];
}

function normalizePosixPath(filePath: string, cwd?: string): string {
  if (path.posix.isAbsolute(filePath)) {
    return path.posix.normalize(filePath);
  }
  const base = cwd && path.posix.isAbsolute(cwd) ? cwd : process.cwd();
  return path.posix.resolve(base, filePath);
}

function matchPosixDeviceReadPath(
  filePath: string,
  cwd?: string,
): UnsafeDeviceReadPathMatch | undefined {
  const normalized = normalizePosixPath(filePath, cwd);
  if (POSIX_BLOCKED_DEVICE_PATHS.has(normalized)) {
    return { path: normalized, reason: "posix-device" };
  }
  if (normalized === "/dev/fd" || normalized.startsWith("/dev/fd/")) {
    return { path: normalized, reason: "posix-fd" };
  }
  if (/^\/proc\/(?:self|thread-self|\d+)\/fd(?:\/|$)/.test(normalized)) {
    return { path: normalized, reason: "posix-fd" };
  }
  return undefined;
}

function normalizeWindowsDeviceBaseName(filePath: string): string {
  const normalized = trimTrailingWindowsSeparators(filePath.replace(/\//g, "\\"));
  const lastSegment = normalized.split("\\").filter(Boolean).at(-1) ?? normalized;
  const withoutStream = lastSegment.split(":")[0] ?? lastSegment;
  const withoutTrailingIgnoredChars = trimTrailingWindowsIgnoredChars(withoutStream);
  return (withoutTrailingIgnoredChars.split(".")[0] ?? withoutTrailingIgnoredChars).toUpperCase();
}

function matchWindowsDeviceReadPath(filePath: string): UnsafeDeviceReadPathMatch | undefined {
  const normalized = filePath.replace(/\//g, "\\");
  if (/^\\\\\.\\/.test(normalized) || /^\\\\\?\\GLOBALROOT\\Device\\/i.test(normalized)) {
    return { path: normalized, reason: "windows-device" };
  }
  const baseName = normalizeWindowsDeviceBaseName(filePath);
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(baseName)) {
    return { path: normalized, reason: "windows-device" };
  }
  return undefined;
}

export function matchUnsafeDeviceReadPath(
  filePath: string,
  options: UnsafeDeviceReadPathOptions = {},
): UnsafeDeviceReadPathMatch | undefined {
  const platform = options.platform ?? process.platform;
  for (const candidate of candidateReadPaths(filePath, platform)) {
    const match = platform === "win32"
      ? matchWindowsDeviceReadPath(candidate)
      : matchPosixDeviceReadPath(candidate, options.cwd);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export function isUnsafeDeviceReadPath(
  filePath: string,
  options?: UnsafeDeviceReadPathOptions,
): boolean {
  return matchUnsafeDeviceReadPath(filePath, options) !== undefined;
}

export function assertNoUnsafeDeviceReadPath(
  filePath: string,
  options?: UnsafeDeviceReadPathOptions,
): void {
  if (matchUnsafeDeviceReadPath(filePath, options)) {
    throw new FsSafeError(
      "device-path",
      `file reads from unsafe device paths are not allowed: ${filePath}`,
    );
  }
}
