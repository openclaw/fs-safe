import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";

const ENCODED_FILE_URL_SEPARATOR_RE = /%(?:2f|5c)/i;
const FILE_URL_PREFIX_RE = /^file:\/\//i;

export function isFileUrl(input: string): boolean {
  return FILE_URL_PREFIX_RE.test(input);
}

function isLocalFileUrlHost(hostname: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(hostname);
  return normalized === "" || normalized === "localhost";
}

export function hasEncodedFileUrlSeparator(pathname: string): boolean {
  return ENCODED_FILE_URL_SEPARATOR_RE.test(pathname);
}

export function isWindowsNetworkPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }
  const normalized = filePath.replace(/\//g, "\\");
  const extendedDrive =
    normalized.length >= 7 &&
    normalized.startsWith("\\\\?\\") &&
    /^[a-z]$/i.test(normalized[4] ?? "") &&
    normalized[5] === ":" &&
    normalized[6] === "\\";
  if (extendedDrive) {
    return false;
  }
  return normalized.startsWith("\\\\");
}

export function isWindowsDriveLetterPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /^[A-Za-z]:[\\/]/.test(filePath);
}

export function assertNoWindowsNetworkPath(filePath: string, label = "Path"): void {
  if (isWindowsNetworkPath(filePath)) {
    throw new Error(`${label} cannot use Windows network paths: ${filePath}`);
  }
}

export function safeFileURLToPath(
  fileUrl: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    throw new Error(`Invalid file:// URL: ${fileUrl}`);
  }
  if (parsed.protocol !== "file:") {
    throw new Error(`Invalid file:// URL: ${fileUrl}`);
  }
  if (!isLocalFileUrlHost(parsed.hostname)) {
    throw new Error(`file:// URLs with remote hosts are not allowed: ${fileUrl}`);
  }
  if (hasEncodedFileUrlSeparator(parsed.pathname)) {
    throw new Error(`file:// URLs cannot encode path separators: ${fileUrl}`);
  }
  const filePath = fileURLToPath(parsed, { windows: platform === "win32" });
  if (isWindowsNetworkPath(filePath, platform)) {
    throw new Error(`Local file URL cannot use Windows network paths: ${filePath}`);
  }
  return filePath;
}

export function trySafeFileURLToPath(
  fileUrl: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  try {
    return safeFileURLToPath(fileUrl, platform);
  } catch {
    return undefined;
  }
}

export function basenameFromMediaSource(source?: string): string | undefined {
  if (!source) {
    return undefined;
  }
  if (isFileUrl(source)) {
    const filePath = trySafeFileURLToPath(source);
    return filePath ? path.basename(filePath) || undefined : undefined;
  }
  if (/^https?:\/\//i.test(source)) {
    try {
      return path.basename(new URL(source).pathname) || undefined;
    } catch {
      return undefined;
    }
  }
  return path.basename(source) || undefined;
}
