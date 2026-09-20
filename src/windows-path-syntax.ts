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
