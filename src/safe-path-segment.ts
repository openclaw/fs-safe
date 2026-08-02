import { FsSafeError } from "./errors.js";

const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const SAFE_DOT_PREFIX_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
// Windows treats "C:name" as relative to the drive's current directory even
// though path.win32.isAbsolute() reports false.
const DRIVE_RELATIVE_PREFIX = /^[A-Za-z]:(?![\\/])/;
const HYPHEN_CHAR_CODE = 0x2d;

export type SafePathSegmentOptions = {
  allowDotPrefix?: boolean;
  label?: string;
};

export function isDriveRelativePath(value: string): boolean {
  return DRIVE_RELATIVE_PREFIX.test(value);
}

export function assertNoDriveRelativePathSegments(value: string, label: string): string {
  if (value.split("/").some(isDriveRelativePath)) {
    throw new FsSafeError("invalid-path", `${label} must not contain a drive letter`);
  }
  return value;
}

function trimHyphenEdges(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === HYPHEN_CHAR_CODE) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === HYPHEN_CHAR_CODE) {
    end -= 1;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

export function isSafePathSegment(
  segment: string,
  options: SafePathSegmentOptions = {},
): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0") &&
    (options.allowDotPrefix === true || !segment.startsWith(".")) &&
    (options.allowDotPrefix === true
      ? SAFE_DOT_PREFIX_PATH_SEGMENT_PATTERN.test(segment)
      : SAFE_PATH_SEGMENT_PATTERN.test(segment))
  );
}

export function assertSafePathSegment(
  segment: string,
  options: SafePathSegmentOptions = {},
): string {
  // Validate the exact value callers will later join into paths; trimming here
  // would let whitespace-padded ids pass and then be used verbatim.
  if (!isSafePathSegment(segment, options)) {
    throw new FsSafeError(
      "invalid-path",
      `${options.label ?? "path segment"} must be a safe path segment`,
    );
  }
  return segment;
}

export function sanitizeSafePathSegment(
  value: string,
  fallback: string,
  options: SafePathSegmentOptions = {},
): string {
  const sanitized = value
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\0/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  const trimmed = trimHyphenEdges(sanitized);
  if (isSafePathSegment(trimmed, options)) {
    return trimmed;
  }
  return assertSafePathSegment(fallback, { ...options, label: "fallback path segment" });
}

export function assertSafePathPrefix(
  prefix: string,
  options: SafePathSegmentOptions = {},
): string {
  // Prefixes are often derived from safe filenames. Normalize harmless
  // filename characters first, but still reject real path-control bytes.
  if (prefix.includes("/") || prefix.includes("\\") || prefix.includes("\0")) {
    return assertSafePathSegment(prefix, {
      allowDotPrefix: true,
      ...options,
      label: options.label ?? "path prefix",
    });
  }
  return assertSafePathSegment(prefix.replace(/[^A-Za-z0-9._-]+/g, "-"), {
    allowDotPrefix: true,
    ...options,
    label: options.label ?? "path prefix",
  });
}
