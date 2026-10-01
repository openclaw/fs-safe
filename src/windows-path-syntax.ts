import path from "node:path";

export function isWindowsSeparator(value: string, offset: number): boolean {
  const code = value.charCodeAt(offset);
  return code === 0x2f || code === 0x5c;
}

export function hasWindowsDrivePrefix(value: string, offset = 0): boolean {
  const letter = value.charCodeAt(offset) | 0x20;
  return letter >= 0x61 && letter <= 0x7a && value.charCodeAt(offset + 1) === 0x3a;
}

/** Classify a raw prefix without normalizing any path components. */
export function windowsNamespaceMarker(value: string): "." | "?" | undefined {
  const marker = value[2];
  return (marker === "." || marker === "?") &&
    isWindowsSeparator(value, 0) && isWindowsSeparator(value, 1) &&
    isWindowsSeparator(value, 3) ? marker : undefined;
}

export function rootedWindowsDriveColonIndex(value: string): number {
  const colon = hasWindowsDrivePrefix(value)
    ? 1
    : windowsNamespaceMarker(value) !== undefined && hasWindowsDrivePrefix(value, 4) ? 5 : -1;
  return colon >= 0 && isWindowsSeparator(value, colon + 1) ? colon : -1;
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 0x20));
}

/**
 * True when dot-like components climb above the start of `segments`. Win32
 * trims trailing dots and spaces, so any all-dot or all-space component other
 * than `.` is counted as a parent step.
 */
export function windowsSegmentsClimbAbove(segments: readonly string[]): boolean {
  let depth = 0;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    depth += /^[. ]+$/.test(segment) ? -1 : 1;
    if (depth < 0) return true;
  }
  return false;
}

/**
 * Comparable share or device root of a path spelled with two leading
 * separators, excluding namespaced drive roots such as `\\?\C:\`.
 * Returns undefined for drive, rooted, and relative spellings, and null when
 * the spelling alone cannot establish which share or device it reaches.
 */
export function windowsShareOrDeviceRoot(value: string): string | null | undefined {
  if (!isWindowsSeparator(value, 0) || !isWindowsSeparator(value, 1)) return undefined;
  const spelled = value.replaceAll("/", "\\");
  if (windowsNamespaceMarker(spelled) === undefined) {
    return asciiLowercase(path.win32.parse(spelled).root.replace(/\\+$/, ""));
  }
  // Node passes namespace spellings to Win32 unchanged, where `..` climbs out
  // of a drive or share (`\\.\C:\..\UNC\host`) and trailing dots, spaces and
  // empty components are rewritten. GLOBALROOT and Global expose whole object
  // namespaces, so none of these identify a single share or device.
  const segments = spelled.slice(4).split("\\");
  const head = asciiLowercase(segments[0] ?? "");
  const authority = head === "unc" ? segments.slice(0, 3) : segments.slice(0, 1);
  if (
    head === "globalroot" || head === "global" || authority.length < (head === "unc" ? 3 : 1) ||
    authority.some(segment => segment === "" || /[. ]$/.test(segment)) ||
    windowsSegmentsClimbAbove(segments.slice(authority.length))
  ) {
    return null;
  }
  if (rootedWindowsDriveColonIndex(value) === 5) return undefined;
  return asciiLowercase(head === "unc"
    ? `\\\\${authority[1]}\\${authority[2]}`
    : `${spelled.slice(0, 4)}${authority[0]}`);
}
