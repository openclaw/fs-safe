import path from "node:path";
import { ArchiveSecurityError } from "./archive-errors.js";
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
    throw new ArchiveSecurityError("entry-path", `archive entry uses a drive path: ${entryPath}`);
  }
  if (entryPath.includes("\0")) {
    throw new ArchiveSecurityError(
      "entry-path",
      `archive entry contains a NUL byte: ${entryPath}`,
    );
  }
  const normalized = path.posix.normalize(normalizeArchiveEntryPath(entryPath));
  const escapeLabel = params?.escapeLabel ?? "destination";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new ArchiveSecurityError(
      "entry-path",
      `archive entry escapes ${escapeLabel}: ${entryPath}`,
    );
  }
  if (path.posix.isAbsolute(normalized) || normalized.startsWith("//")) {
    throw new ArchiveSecurityError("entry-path", `archive entry is absolute: ${entryPath}`);
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
    if (seen.has(normalized)) {
      throw new ArchiveSecurityError(
        "entry-path",
        `archive entries collide at output path ${normalized}: ${originalPath}`,
      );
    }
    seen.add(normalized);
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
      `archive entry escapes ${escapeLabel}: ${params.originalPath}`,
    );
  }
  return outPath;
}
