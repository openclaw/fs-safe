import { createHash } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { isPathInside } from "./path.js";
import { realpathSync } from "./realpath.js";
import {
  hasWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

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
    .replaceAll(/[^a-zA-Z0-9._]+/g, "-")
    .replaceAll(/^-|-$/g, "");

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
  const baseDir = params.baseDir;
  if (hasWindowsPathAlias(baseDir, "filesystem")) {
    return { ok: false, error: params.invalidNameMessage };
  }
  const encodedName = (params.nameEncoder ?? safeDirName)(params.id);
  if (hasWindowsPathAlias(encodedName, "relative")) {
    return { ok: false, error: params.invalidNameMessage };
  }
  const targetDir = path.join(baseDir, encodedName);
  if (hasWindowsPathAlias(targetDir, "filesystem")) {
    return { ok: false, error: params.invalidNameMessage };
  }
  const resolvedBase = resolvePathPreservingWindowsRoot(baseDir);
  const resolvedTarget = path.resolve(targetDir);
  if (
    hasWindowsPathAlias(resolvedBase, "filesystem") ||
    hasWindowsPathAlias(resolvedTarget, "filesystem")
  ) {
    return { ok: false, error: params.invalidNameMessage };
  }
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
  const baseDirInput = params.baseDir;
  const candidatePathInput = params.candidatePath;
  const boundaryLabel = params.boundaryLabel;
  const invalidPath = (): Error =>
    new Error(`Invalid path: must stay within ${boundaryLabel}`);
  const assertAdmittedPath = (value: string): void => {
    if (hasWindowsPathAlias(value, "filesystem")) throw invalidPath();
  };

  assertAdmittedPath(baseDirInput);
  assertAdmittedPath(candidatePathInput);
  const baseDir = resolvePathPreservingWindowsRoot(baseDirInput);
  const candidatePath = resolvePathPreservingWindowsRoot(candidatePathInput);
  assertAdmittedPath(baseDir);
  assertAdmittedPath(candidatePath);
  if (!isPathInside(baseDir, candidatePath)) {
    throw invalidPath();
  }

  const baseOperationPath = pathForWindowsFilesystem(baseDir);
  const baseLstat = fsSync.lstatSync(baseOperationPath);
  if (baseLstat.isSymbolicLink()) {
    const baseStat = fsSync.statSync(baseOperationPath);
    if (!baseStat.isDirectory()) {
      throw new Error(
        `Invalid ${boundaryLabel}: base directory must resolve to a directory`,
      );
    }
  } else if (!baseLstat.isDirectory()) {
    throw new Error(`Invalid ${boundaryLabel}: base directory must be a directory`);
  }
  const baseRealPath = realpathSync.native(baseOperationPath);
  assertAdmittedPath(baseRealPath);

  const validateDirectory = async (dirPath: string): Promise<void> => {
    assertAdmittedPath(dirPath);
    const resolvedDirPath = resolvePathPreservingWindowsRoot(dirPath);
    assertAdmittedPath(resolvedDirPath);
    const operationPath = pathForWindowsFilesystem(dirPath);
    const dirLstat = fsSync.lstatSync(operationPath);
    if (dirLstat.isSymbolicLink()) {
      if (resolvedDirPath !== baseDir) {
        throw new Error(`Invalid path: must stay within ${boundaryLabel}`);
      }
      const dirStat = fsSync.statSync(operationPath);
      if (!dirStat.isDirectory()) {
        throw new Error(`Invalid path: must stay within ${boundaryLabel}`);
      }
    } else if (!dirLstat.isDirectory()) {
      throw new Error(`Invalid path: must stay within ${boundaryLabel}`);
    }
    const dirRealPath = realpathSync.native(operationPath);
    assertAdmittedPath(dirRealPath);
    if (!isPathInside(baseRealPath, dirRealPath)) {
      throw invalidPath();
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
  const candidateParent = path.dirname(candidatePath);
  assertAdmittedPath(candidateParent);
  await validateDirectory(candidateParent);
}
