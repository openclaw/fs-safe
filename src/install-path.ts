import { createHash } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { isPathInside } from "./path.js";
import { realpathSync } from "./realpath.js";

export function safeDirName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.replaceAll("/", "__").replaceAll("\\", "__");
}

/** Legacy readable encoding; distinct IDs can share a result. Use V2 for untrusted IDs. */
export function safePathSegmentHashed(input: string): string {
  const trimmed = input.trim();
  const base = trimmed
    .replaceAll(/[\\/]/g, "-")
    .replaceAll(/[^a-zA-Z0-9._-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-+/g, "")
    .replaceAll(/-+$/g, "");

  const normalized = base.length > 0 ? base : "skill";
  const safe = normalized === "." || normalized === ".." ? "skill" : normalized;

  if (safe !== trimmed || safe.length > 60) {
    const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 10);
    return `${safe.slice(0, 50)}-${hash}`;
  }
  return safe;
}

/**
 * Versioned install-ID encoding: every trimmed ID receives a domain-separated
 * SHA-256 digest. Only surrounding whitespace is intentionally equivalent.
 */
export function safePathSegmentHashedV2(input: string): string {
  const hash = createHash("sha256")
    .update("@openclaw/fs-safe:install-path:v2\0", "utf8")
    // UTF-16LE preserves every JavaScript code unit, including lone surrogates.
    .update(input.trim(), "utf16le")
    .digest("hex");
  return `id-v2-${hash}`;
}

export function resolveSafeInstallDir(params: {
  baseDir: string;
  id: string;
  invalidNameMessage: string;
  nameEncoder?: (id: string) => string;
}): { ok: true; path: string } | { ok: false; error: string } {
  const encodedName = (params.nameEncoder ?? safeDirName)(params.id);
  const targetDir = path.join(params.baseDir, encodedName);
  const resolvedBase = path.resolve(params.baseDir);
  const resolvedTarget = path.resolve(targetDir);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return { ok: false, error: params.invalidNameMessage };
  }
  return { ok: true, path: resolvedTarget };
}

export async function assertCanonicalPathWithinBase(params: {
  baseDir: string;
  candidatePath: string;
  boundaryLabel: string;
}): Promise<void> {
  const baseDir = path.resolve(params.baseDir);
  const candidatePath = path.resolve(params.candidatePath);
  if (!isPathInside(baseDir, candidatePath)) {
    throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
  }

  const baseLstat = fsSync.lstatSync(baseDir);
  if (baseLstat.isSymbolicLink()) {
    const baseStat = fsSync.statSync(baseDir);
    if (!baseStat.isDirectory()) {
      throw new Error(
        `Invalid ${params.boundaryLabel}: base directory must resolve to a directory`,
      );
    }
  } else if (!baseLstat.isDirectory()) {
    throw new Error(`Invalid ${params.boundaryLabel}: base directory must be a directory`);
  }
  const baseRealPath = realpathSync.native(baseDir);

  const validateDirectory = async (dirPath: string): Promise<void> => {
    const resolvedDirPath = path.resolve(dirPath);
    const dirLstat = fsSync.lstatSync(dirPath);
    if (dirLstat.isSymbolicLink()) {
      if (resolvedDirPath !== baseDir) {
        throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
      }
      const dirStat = fsSync.statSync(dirPath);
      if (!dirStat.isDirectory()) {
        throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
      }
    } else if (!dirLstat.isDirectory()) {
      throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
    }
    const dirRealPath = realpathSync.native(dirPath);
    if (!isPathInside(baseRealPath, dirRealPath)) {
      throw new Error(`Invalid path: must stay within ${params.boundaryLabel}`);
    }
  };

  try {
    await validateDirectory(candidatePath);
    return;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
  await validateDirectory(path.dirname(candidatePath));
}
