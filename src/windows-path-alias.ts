import { FsSafeError } from "./errors.js";

export type WindowsPathAliasKind = "filesystem" | "relative";

const COLON = 0x3a;
const FORWARD_SLASH = 0x2f;
const BACKSLASH = 0x5c;
const DOT = 0x2e;
const QUESTION_MARK = 0x3f;

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isSeparator(code: number): boolean {
  return code === FORWARD_SLASH || code === BACKSLASH;
}

function rootedDriveColonIndex(value: string): number {
  if (
    value.length >= 3 &&
    isAsciiLetter(value.charCodeAt(0)) &&
    value.charCodeAt(1) === COLON &&
    isSeparator(value.charCodeAt(2))
  ) {
    return 1;
  }

  if (
    value.length >= 7 &&
    isSeparator(value.charCodeAt(0)) &&
    isSeparator(value.charCodeAt(1)) &&
    (value.charCodeAt(2) === QUESTION_MARK || value.charCodeAt(2) === DOT) &&
    isSeparator(value.charCodeAt(3)) &&
    isAsciiLetter(value.charCodeAt(4)) &&
    value.charCodeAt(5) === COLON &&
    isSeparator(value.charCodeAt(6))
  ) {
    return 5;
  }

  return -1;
}

/** Returns true when a Windows pathname can address an alternate filesystem namespace. */
export function hasWindowsPathAlias(
  value: string,
  kind: WindowsPathAliasKind,
  platform: NodeJS.Platform | string = process.platform,
): boolean {
  if (platform !== "win32") return false;
  const firstColon = value.indexOf(":");
  if (firstColon === -1) return false;
  if (kind === "relative") return true;
  return firstColon !== rootedDriveColonIndex(value) || value.indexOf(":", firstColon + 1) !== -1;
}

export function assertNoWindowsPathAlias(
  value: string,
  kind: WindowsPathAliasKind = "filesystem",
  message = "path uses a Windows filesystem namespace alias",
  platform: NodeJS.Platform | string = process.platform,
): void {
  if (hasWindowsPathAlias(value, kind, platform)) {
    throw new FsSafeError("invalid-path", message, {
      details: { reason: "windows-path-alias" },
    });
  }
}

export function isWindowsPathAliasError(error: unknown): error is FsSafeError {
  return error instanceof FsSafeError && error.details?.reason === "windows-path-alias";
}
