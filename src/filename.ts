import path from "node:path";
import { WINDOWS_RESERVED_DEVICE_NAMES } from "./device-path.js";

const WINDOWS_INVALID_FILE_NAME_CHARACTERS = new Set('<>:"/\\|?*');

function suffixWindowsReservedDeviceName(fileName: string): string {
  const extensionIndex = fileName.indexOf(".");
  const baseNameEnd = extensionIndex < 0 ? fileName.length : extensionIndex;
  const baseName = fileName.slice(0, baseNameEnd);
  if (!WINDOWS_RESERVED_DEVICE_NAMES.has(baseName.toUpperCase())) {
    return fileName;
  }
  return `${baseName}_${fileName.slice(baseNameEnd)}`;
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
  }
  return base;
}
