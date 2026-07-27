import path from "node:path";
import { isWindowsReservedDeviceBaseName } from "./device-path.js";

const WINDOWS_INVALID_FILE_NAME_CHARACTERS = new Set('<>:"/\\|?*');

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
  // Windows treats these basenames as devices even with an extension
  // (NUL.txt opens the NUL device). Refuse them so staging/output helpers
  // never create reserved paths from untrusted names.
  if (isWindowsReservedDeviceBaseName(base)) {
    return fallbackName;
  }
  if (base.length > 200) {
    base = base.slice(0, 200);
  }
  return base;
}
