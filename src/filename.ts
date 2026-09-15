import path from "node:path";
import { WINDOWS_RESERVED_DEVICE_NAMES } from "./device-path.js";
import { maxNormalizedUtf8Bytes } from "./unicode-path.js";

const INVALID_FILE_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g;
const HAS_INVALID_FILE_NAME_CHARACTER = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/;

function canStartWindowsDeviceName(character: number): boolean {
  const folded = character | 0x20;
  return folded === 0x61 || folded === 0x63 || folded === 0x6c ||
    folded === 0x6e || folded === 0x70;
}

function windowsDeviceStemEnd(value: string, stemEnd: number): number {
  let end = stemEnd;
  while (end > 0) {
    const character = value.charCodeAt(end - 1);
    if (character !== 0x20 && character !== 0x2e) {
      break;
    }
    end -= 1;
  }
  return end;
}

export function suffixWindowsReservedDeviceName(fileName: string): string {
  if (!canStartWindowsDeviceName(fileName.charCodeAt(0))) {
    return fileName;
  }
  const extensionIndex = fileName.indexOf(".");
  const baseNameEnd = extensionIndex < 0 ? fileName.length : extensionIndex;
  const deviceBaseNameEnd = windowsDeviceStemEnd(fileName, baseNameEnd);
  if (
    deviceBaseNameEnd === 0 ||
    deviceBaseNameEnd > 7 ||
    !WINDOWS_RESERVED_DEVICE_NAMES.has(fileName.slice(0, deviceBaseNameEnd).toUpperCase())
  ) {
    return fileName;
  }
  return `${fileName.slice(0, baseNameEnd)}_${fileName.slice(baseNameEnd)}`;
}

const PORTABLE_FILE_NAME_BYTES = 255;
const SANITIZED_FILE_NAME_CODE_UNITS = 200;
const SAFE_FALLBACK_FILE_NAME = "file";

/**
 * Uses native string and regexp operations to recognize the full sanitizer's
 * bounded fixed points. The separate non-global regexp keeps this predicate
 * stateless, and the authoritative device-name transform remains the final
 * admission check.
 */
function isBoundedSanitizedFileName(
  fileName: unknown,
  trimmedFileName: string,
): fileName is string {
  return typeof fileName === "string" &&
    fileName.length > 0 &&
    fileName.length <= SANITIZED_FILE_NAME_CODE_UNITS &&
    fileName !== "." &&
    fileName !== ".." &&
    trimmedFileName === fileName &&
    !HAS_INVALID_FILE_NAME_CHARACTER.test(fileName) &&
    suffixWindowsReservedDeviceName(fileName) === fileName;
}

function hasWindowsDrivePrefix(value: string): boolean {
  if (value.length < 2 || value.charCodeAt(1) !== 0x3a) return false;
  const firstCodeUnit = value.charCodeAt(0);
  return (firstCodeUnit >= 0x41 && firstCodeUnit <= 0x5a) ||
    (firstCodeUnit >= 0x61 && firstCodeUnit <= 0x7a);
}

function normalizedFileNameBytes(value: string): number {
  return maxNormalizedUtf8Bytes(value, true);
}

function truncateCodeUnitsWithoutSplittingSurrogate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let truncated = value.slice(0, limit);
  const trailingCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
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

function sanitizeTransformedFileName(trimmed: string): string | undefined {
  let base = trimmed;
  if (base.includes("/")) base = path.posix.basename(base);
  if (base.includes("\\") || hasWindowsDrivePrefix(base)) {
    base = path.win32.basename(base);
  }
  base = base.replace(INVALID_FILE_NAME_CHARACTERS, "").trim();
  if (!base || base === "." || base === "..") {
    return undefined;
  }
  base = truncateCodeUnitsWithoutSplittingSurrogate(base, SANITIZED_FILE_NAME_CODE_UNITS);
  let safeBase = suffixWindowsReservedDeviceName(base);
  if (safeBase.length > SANITIZED_FILE_NAME_CODE_UNITS) {
    // The safety suffix is the final invariant. Shorten the unsuffixed tail so
    // truncation cannot turn a padded reserved stem back into a device name.
    base = truncateCodeUnitsWithoutSplittingSurrogate(
      base,
      SANITIZED_FILE_NAME_CODE_UNITS - 1,
    );
    safeBase = suffixWindowsReservedDeviceName(base);
  }
  return safeBase;
}

function sanitizeFileNameCandidate(fileName: string): string | undefined {
  if (typeof fileName !== "string") return undefined;
  const trimmed = fileName.trim();
  if (!trimmed) return undefined;
  if (isBoundedSanitizedFileName(fileName, trimmed)) return fileName;
  return sanitizeTransformedFileName(trimmed);
}

export function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string {
  return (
    sanitizeFileNameCandidate(fileName) ??
    sanitizeFileNameCandidate(fallbackName) ??
    SAFE_FALLBACK_FILE_NAME
  );
}
