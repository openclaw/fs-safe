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
 * Comparable share or device root of a path spelled with two leading
 * separators, excluding namespaced drive roots such as `\\?\C:\`.
 * Returns undefined for drive, rooted, and relative spellings, and null when
 * the spelling alone cannot establish which share or device it reaches.
 */
export function windowsShareOrDeviceRoot(value: string): string | null | undefined {
  if (!isWindowsSeparator(value, 0) || !isWindowsSeparator(value, 1)) return undefined;
  const spelled = value.replaceAll("/", "\\");
  const namespaced = windowsNamespaceMarker(spelled) !== undefined;
  if (namespaced) {
    // Win32 trims trailing dots and spaces and collapses empty components, and
    // dot segments climb out of a drive or share (`\\.\C:\..\UNC\host`), so any
    // component it would rewrite hides the target. GLOBALROOT or Global expose
    // whole object namespaces.
    const segments = spelled.slice(4).split("\\");
    const head = asciiLowercase(segments[0] ?? "");
    if (
      head === "globalroot" || head === "global" ||
      segments.some((segment, index) => /[. ]$/.test(segment) || (segment === "" && index < segments.length - 1))
    ) {
      return null;
    }
  }
  if (rootedWindowsDriveColonIndex(value) === 5) return undefined;
  const folded = namespaced && asciiLowercase(spelled.slice(4, 8)) === "unc\\"
    ? `\\\\${spelled.slice(8)}`
    : spelled;
  return asciiLowercase(path.win32.parse(folded).root.replace(/\\+$/, ""));
}
