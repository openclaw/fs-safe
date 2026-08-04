import path from "node:path";
import { ArchiveSecurityError } from "./archive-errors.js";
import { formatErrorDetail } from "./error-detail.js";
import { resolveSafeBaseDir } from "./path.js";

export function isWindowsDrivePath(value: string): boolean {
  return normalizeArchiveEntryPath(value)
    .split("/")
    .some((segment) => /^[a-zA-Z]:/.test(segment));
}

export function normalizeArchiveEntryPath(raw: string): string {
  return raw.replaceAll("\\", "/");
}

export function validateArchiveEntryPath(
  entryPath: string,
  params?: { escapeLabel?: string },
): void {
  if (!entryPath || entryPath === "." || entryPath === "./") {
    return;
  }
  if (isWindowsDrivePath(entryPath)) {
    throw new ArchiveSecurityError(
      "entry-path",
      `archive entry uses a drive path: ${formatErrorDetail(entryPath)}`,
    );
  }
  if (entryPath.includes("\0")) {
    throw new ArchiveSecurityError(
      "entry-path",
      `archive entry contains a NUL byte: ${formatErrorDetail(entryPath)}`,
    );
  }
  const slashNormalized = normalizeArchiveEntryPath(entryPath);
  if (
    process.platform === "win32" &&
    slashNormalized.split("/").some((segment) => segment.includes(":"))
  ) {
    throw new ArchiveSecurityError(
      "entry-path",
      `archive entry uses a Windows alternate data stream path: ${formatErrorDetail(entryPath)}`,
    );
  }
  const normalized = path.posix.normalize(slashNormalized);
  if (
    normalized.split("/").some((segment) =>
      Math.max(
        Buffer.byteLength(segment.normalize("NFC")),
        Buffer.byteLength(segment.normalize("NFD")),
      ) > 255
    )
  ) {
    throw new ArchiveSecurityError(
      "entry-path",
      `archive entry has an overlong path component: ${formatErrorDetail(entryPath)}`,
    );
  }
  const escapeLabel = params?.escapeLabel ?? "destination";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new ArchiveSecurityError(
      "entry-path",
      `archive entry escapes ${escapeLabel}: ${formatErrorDetail(entryPath)}`,
    );
  }
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("//")) {
    throw new ArchiveSecurityError(
      "entry-path",
      `archive entry is absolute: ${formatErrorDetail(entryPath)}`,
    );
  }
  if (slashNormalized.split("/").includes("..")) {
    throw new ArchiveSecurityError(
      "entry-path",
      `archive entry contains a parent segment: ${formatErrorDetail(entryPath)}`,
    );
  }
}

export function stripArchivePath(entryPath: string, stripComponents: number): string | null {
  const raw = normalizeArchiveEntryPath(entryPath);
  if (!raw || raw === "." || raw === "./") {
    return null;
  }

  const parts = raw.split("/").filter((part) => part.length > 0 && part !== ".");
  const strip = Math.max(0, Math.floor(stripComponents));
  const stripped = strip === 0 ? parts.join("/") : parts.slice(strip).join("/");
  const result = path.posix.normalize(stripped);
  if (!result || result === "." || result === "./") {
    return null;
  }
  return result;
}

export function createArchiveOutputPathTracker(): (entryPath: string, originalPath: string) => void {
  const seen = new Set<string>();
  return (entryPath, originalPath) => {
    const normalized = path.posix.normalize(normalizeArchiveEntryPath(entryPath));
    // Archive policy must not depend on the destination volume's case or
    // Unicode-normalization behavior. Otherwise the JavaScript and native
    // writers can disagree about which of two colliding entries wins.
    const collisionKey = normalized.normalize("NFC").toLowerCase().normalize("NFC");
    if (seen.has(collisionKey)) {
      throw new ArchiveSecurityError(
        "entry-path",
        `archive entries collide at output path ${formatErrorDetail(normalized)}: ${formatErrorDetail(originalPath)}`,
      );
    }
    seen.add(collisionKey);
  };
}

export function resolveArchiveOutputPath(params: {
  rootDir: string;
  relPath: string;
  originalPath: string;
  escapeLabel?: string;
}): string {
  const safeBase = resolveSafeBaseDir(params.rootDir);
  const outPath = path.resolve(params.rootDir, params.relPath);
  const escapeLabel = params.escapeLabel ?? "destination";
  if (!outPath.startsWith(safeBase)) {
    throw new ArchiveSecurityError(
      "entry-path",
      `archive entry escapes ${escapeLabel}: ${formatErrorDetail(params.originalPath)}`,
    );
  }
  return outPath;
}
