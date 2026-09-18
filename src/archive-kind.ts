import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getNativeBinding } from "./native.js";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";

export type ArchiveKind = "tar" | "tar-bzip2" | "tar-zstd" | "zip";

const TAR_SUFFIXES = [".tgz", ".tar.gz", ".tar"];
const COMPRESSED_TAR_SUFFIXES = [
  { suffixes: [".tbz2", ".tbz", ".tar.bz2"], kind: "tar-bzip2" },
  { suffixes: [".tzst", ".tar.zst", ".tar.zstd"], kind: "tar-zstd" },
] as const;

export function resolveArchiveKind(filePath: string): ArchiveKind | null {
  const lower = normalizeLowercaseStringOrEmpty(filePath);
  if (lower.endsWith(".zip")) {
    return "zip";
  }
  for (const { suffixes, kind } of COMPRESSED_TAR_SUFFIXES) {
    if (suffixes.some((suffix) => lower.endsWith(suffix))) {
      // Preserve strict require diagnostics even when only resolving a suffix.
      getNativeBinding();
      return kind;
    }
  }
  if (TAR_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return "tar";
  }
  return null;
}

type ResolvePackedRootDirOptions = {
  rootMarkers?: string[];
};

async function hasPackedRootMarker(extractDir: string, rootMarkers: string[]): Promise<boolean> {
  for (const marker of rootMarkers) {
    const trimmed = marker.trim();
    if (!trimmed) {
      continue;
    }
    try {
      fsSync.statSync(path.join(extractDir, trimmed));
      return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export async function resolvePackedRootDir(
  extractDir: string,
  options?: ResolvePackedRootDirOptions,
): Promise<string> {
  const direct = path.join(extractDir, "package");
  try {
    const stat = fsSync.statSync(direct);
    if (stat.isDirectory()) {
      return direct;
    }
  } catch {
    // ignore
  }

  if ((options?.rootMarkers?.length ?? 0) > 0) {
    const hasMarker = await hasPackedRootMarker(extractDir, options?.rootMarkers ?? []);
    if (hasMarker) {
      return extractDir;
    }
  }

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (dirs.length !== 1) {
    throw new Error(`unexpected archive layout (dirs: ${dirs.join(", ")})`);
  }
  const onlyDir = dirs[0];
  if (!onlyDir) {
    throw new Error("unexpected archive layout (no package dir found)");
  }
  return path.join(extractDir, onlyDir);
}
