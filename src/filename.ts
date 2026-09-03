import path from "node:path";
import { WINDOWS_RESERVED_DEVICE_NAMES } from "./device-path.js";

const WINDOWS_INVALID_FILE_NAME_CHARACTERS = new Set('<>:"/\\|?*');

function trimWindowsIgnoredSuffix(value: string): string {
  let end = value.length;
  while (end > 0) {
    const character = value.charCodeAt(end - 1);
    if (character !== 0x20 && character !== 0x2e) {
      break;
    }
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function suffixWindowsReservedDeviceName(fileName: string): string {
  const extensionIndex = fileName.indexOf(".");
  const baseNameEnd = extensionIndex < 0 ? fileName.length : extensionIndex;
  const baseName = fileName.slice(0, baseNameEnd);
  const deviceBaseName = trimWindowsIgnoredSuffix(baseName);
  if (!WINDOWS_RESERVED_DEVICE_NAMES.has(deviceBaseName.toUpperCase())) {
    return fileName;
  }
  return `${baseName}_${fileName.slice(baseNameEnd)}`;
}

const PORTABLE_FILE_NAME_BYTES = 255;

function normalizedFileNameBytes(value: string): number {
  return Math.max(
    Buffer.byteLength(value.normalize("NFC"), "utf8"),
    Buffer.byteLength(value.normalize("NFD"), "utf8"),
  );
}

/** Keeps short names exact and trims only the filename tail of a composite temp name. */
export function fitFileNameToPortableComponent(params: {
  prefix: string;
  fileName: string;
  suffix: string;
}): string {
  const complete = `${params.prefix}${params.fileName}${params.suffix}`;
  if (normalizedFileNameBytes(complete) <= PORTABLE_FILE_NAME_BYTES) {
    return params.fileName;
  }
  if (normalizedFileNameBytes(`${params.prefix}${params.suffix}`) > PORTABLE_FILE_NAME_BYTES) {
    // Preserve the existing OS error for a caller-supplied prefix that cannot fit.
    return params.fileName;
  }

  const extension = path.extname(params.fileName);
  const preserveExtension = normalizedFileNameBytes(`${params.prefix}${extension}${params.suffix}`) <=
    PORTABLE_FILE_NAME_BYTES;
  const tailSuffix = preserveExtension ? extension : "";
  const stem = preserveExtension
    ? params.fileName.slice(0, params.fileName.length - extension.length)
    : params.fileName;
  const codePoints = Array.from(stem);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const candidate = `${params.prefix}${codePoints.slice(0, length).join("")}${tailSuffix}${params.suffix}`;
    if (normalizedFileNameBytes(candidate) <= PORTABLE_FILE_NAME_BYTES) {
      low = length;
    } else {
      high = length - 1;
    }
  }
  return `${codePoints.slice(0, low).join("")}${tailSuffix}`;
}

export function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string {
  const trimmed = typeof fileName === "string" ? fileName.trim() : "";
  if (!trimmed) {
    return fallbackName;
  }
  let base = path.posix.basename(trimmed);
  base = path.win32.basename(base);
  let cleaned = "";
  for (let i = 0; i < base.length; i++) {
    const code = base.charCodeAt(i);
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      WINDOWS_INVALID_FILE_NAME_CHARACTERS.has(base[i]!)
    ) {
      continue;
    }
    cleaned += base[i];
  }
  base = cleaned.trim();
  if (!base || base === "." || base === "..") {
    return fallbackName;
  }
  base = suffixWindowsReservedDeviceName(base);
  if (base.length > 200) {
    base = base.slice(0, 200);
    const trailingCodeUnit = base.charCodeAt(base.length - 1);
    if (trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff) {
      base = base.slice(0, -1);
    }
  }
  return base;
}
