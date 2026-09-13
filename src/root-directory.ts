import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorDetail } from "./error-detail.js";
import { FsSafeError } from "./errors.js";
import {
  assertNoNulPathInput,
  hasNodeErrorCode,
  isNodeError,
  isNotFoundPathError,
  isPathInside,
  isPathRelativeEscape,
} from "./path.js";
import { resolvePathWithinRoot } from "./root-paths-lexical.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

export type DirectoryResult =
  | { ok: true; path: string }
  | { ok: false; error: string; diagnostic?: FsSafeError };

function invalidPath(scopeLabel: string): { ok: false; error: string } {
  return { ok: false, error: `Invalid path: must stay within ${scopeLabel}` };
}

export function resolveNearestExistingPath(targetPath: string): string {
  assertNoWindowsPathAlias(targetPath);
  let current = path.resolve(targetPath);
  assertNoWindowsPathAlias(current);
  while (true) {
    try {
      fsSync.lstatSync(current);
      return current;
    } catch (err) {
      if (!isNotFoundPathError(err)) throw err;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`failed to resolve existing path for ${targetPath}`);
    }
    current = parent;
  }
}

export async function assertNoSymlinkSegments(params: {
  rootDir: string;
  targetPath: string;
  scopeLabel: string;
}): Promise<void> {
  const relative = path.relative(params.rootDir, params.targetPath);
  if (isPathRelativeEscape(relative)) {
    throw new FsSafeError("outside-workspace", `Invalid path: must stay within ${params.scopeLabel}`);
  }
  let current = params.rootDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = fsSync.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new FsSafeError(
          "symlink", `Invalid path: must not traverse symlinks within ${params.scopeLabel}`,
        );
      }
      if (!stat.isDirectory()) {
        throw new FsSafeError(
          "not-file",
          `Invalid path: existing segment must be a directory within ${params.scopeLabel}`,
        );
      }
    } catch (err) {
      if (isNotFoundPathError(err)) return;
      throw err;
    }
  }
}

export async function ensureDirectoryWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultDirName?: string;
  mode?: number;
}): Promise<DirectoryResult> {
  const scopeLabel = formatErrorDetail(params.scopeLabel.slice(0, 80));
  try {
    const rootDirInput = params.rootDir;
    const requestedPathInput = params.requestedPath;
    const useDefault = !requestedPathInput.trim();
    const defaultDirName = useDefault ? params.defaultDirName : undefined;
    const mode = params.mode;
    assertNoNulPathInput(rootDirInput);
    assertNoNulPathInput(requestedPathInput);
    if (useDefault) assertNoNulPathInput(defaultDirName ?? "");
    assertNoWindowsPathAlias(rootDirInput);
    assertNoWindowsPathAlias(requestedPathInput);
    if (useDefault) assertNoWindowsPathAlias(defaultDirName ?? "");
    const lexical = resolvePathWithinRoot({
      rootDir: rootDirInput,
      requestedPath: requestedPathInput,
      scopeLabel,
      defaultFileName: defaultDirName,
    });
    if (!lexical.ok) return lexical;
    const rootDir = path.resolve(rootDirInput);
    const targetPath = lexical.path;
    const rootStat = fsSync.lstatSync(rootDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return invalidPath(scopeLabel);
    await assertNoSymlinkSegments({ rootDir, targetPath, scopeLabel });
    const rootReal = fsSync.realpathSync.native(rootDir);
    assertNoWindowsPathAlias(rootReal);
    const nearestExistingPath = resolveNearestExistingPath(targetPath);
    const nearestExistingReal = fsSync.realpathSync.native(nearestExistingPath);
    assertNoWindowsPathAlias(nearestExistingReal);
    if (!isPathInside(rootReal, nearestExistingReal)) return invalidPath(scopeLabel);
    const relative = path.relative(rootDir, targetPath);
    let current = rootDir;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      while (true) {
        try {
          const stat = fsSync.lstatSync(current);
          if (stat.isSymbolicLink() || !stat.isDirectory()) return invalidPath(scopeLabel);
          break;
        } catch (err) {
          if (!isNotFoundPathError(err)) throw err;
          try {
            await fs.mkdir(current, { mode });
          } catch (mkdirErr) {
            if (hasNodeErrorCode(mkdirErr, "EEXIST")) continue;
            throw mkdirErr;
          }
        }
      }
      const currentReal = fsSync.realpathSync.native(current);
      assertNoWindowsPathAlias(currentReal);
      if (!isPathInside(rootReal, currentReal)) return invalidPath(scopeLabel);
    }
    const targetReal = fsSync.realpathSync.native(targetPath);
    assertNoWindowsPathAlias(targetReal);
    if (!isPathInside(rootReal, targetReal)) return invalidPath(scopeLabel);
    return { ok: true, path: targetPath };
  } catch (cause) {
    if (
      (cause instanceof FsSafeError && cause.category === "policy") ||
      hasNodeErrorCode(cause, "ENOTDIR")
    ) {
      return invalidPath(scopeLabel);
    }
    const code = isNodeError(cause) && typeof cause.code === "string"
      ? formatErrorDetail(cause.code.slice(0, 40)) : "filesystem operation failed";
    const syscall = isNodeError(cause) && typeof cause.syscall === "string"
      ? ` during ${formatErrorDetail(cause.syscall.slice(0, 40))}` : "";
    const diagnostic = new FsSafeError(
      "helper-failed", `Could not prepare ${scopeLabel}: ${code}${syscall}`, { cause },
    );
    return { ok: false, error: diagnostic.message, diagnostic };
  }
}
