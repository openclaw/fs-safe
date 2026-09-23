import fsSync from "node:fs";
import path from "node:path";
import { normalizeMaxBytes } from "./byte-budget.js";
import { FsSafeError } from "./errors.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "./home-dir.js";
import { isFileUrl, safeFileURLToPath } from "./local-file-access.js";
import { realpathSync } from "./realpath.js";
import { ROOT_PATH_ALIAS_POLICIES, resolveRootPathSync } from "./root-path.js";
import { root, type ReadResult, type RootReadOptions } from "./root.js";
import {
  assertNoWindowsPathAlias,
  isWindowsPathAliasError,
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export type LocalRootsPathResult = {
  path: string;
  root: string;
};

export type LocalRootsReadResult = ReadResult & {
  root: string;
};

export type LocalRootsInputOptions = {
  filePath: string;
  roots: readonly string[];
  label?: string;
};

export type ResolveLocalPathFromRootsSyncOptions = LocalRootsInputOptions & {
  allowMissing?: boolean;
  requireFile?: boolean;
};

export type ReadLocalFileFromRootsOptions = LocalRootsInputOptions & RootReadOptions;

function resolveLocalPathInput(input: string, label: string): string {
  if (isFileUrl(input)) {
    try {
      return safeFileURLToPath(input);
    } catch {
      const location = label === "file path" ? "" : ` in ${label}`;
      throw new Error(`Invalid file:// URL${location}: ${input}`);
    }
  }
  if (input.includes("\0")) {
    throw new FsSafeError("invalid-path", `${label} must not contain NUL bytes`);
  }
  assertNoWindowsPathAlias(input, "filesystem", `${label} uses a Windows filesystem namespace alias`);
  const homePrefix = input === "~" || input.startsWith("~/") ||
    (path.sep === "\\" && input.startsWith("~\\"));
  const expanded = homePrefix ? `${resolveRequiredHomeDir()}${path.sep}${input.slice(2)}` : input;
  assertNoWindowsPathAlias(expanded, "filesystem", `${label} uses a Windows filesystem namespace alias`);
  if (path.isAbsolute(expanded)) return expanded;
  const drive = path.parse(expanded).root;
  const base = drive ? path.resolve(drive) : process.cwd();
  const resolved = `${base}${path.sep}${expanded.slice(drive.length)}`;
  assertNoWindowsPathAlias(resolved, "filesystem", `${label} uses a Windows filesystem namespace alias`);
  return resolved;
}

function resolveLocalRootInput(input: string, label: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new FsSafeError("invalid-path", `${label} entry is required`);
  }
  const resolved = isFileUrl(trimmed)
    ? resolveLocalPathInput(trimmed, label)
    : expandHomePrefix(trimmed);
  if (resolved.includes("\0")) {
    throw new FsSafeError("invalid-path", `${label} entry must not contain NUL bytes`);
  }
  assertNoWindowsPathAlias(resolved, "filesystem", `${label} entry uses a Windows filesystem namespace alias`);
  if (!path.isAbsolute(resolved)) {
    throw new FsSafeError("invalid-path", `${label} entries must be absolute paths: ${input}`);
  }
  const absolute = resolvePathPreservingWindowsRoot(resolved);
  assertNoWindowsPathAlias(absolute, "filesystem", `${label} entry uses a Windows filesystem namespace alias`);
  return absolute;
}

function resolveRootRealSync(rootDir: string): string | null {
  let realPath: string;
  try {
    // Configured roots may themselves be symlinks. Follow only this trusted
    // root entry, then use its canonical directory for containment checks.
    const operationPath = pathForWindowsFilesystem(rootDir);
    const stat = fsSync.statSync(operationPath);
    if (!stat.isDirectory()) {
      return null;
    }
    realPath = realpathSync(operationPath);
  } catch {
    return null;
  }
  assertNoWindowsPathAlias(realPath, "filesystem", "local root uses a Windows filesystem namespace alias");
  return realPath;
}

function prepareLocalRootsInput(options: LocalRootsInputOptions) {
  const label = options.label ?? "local roots";
  const rootDirs = options.roots.map((rootEntry) => resolveLocalRootInput(rootEntry, label));
  let requestedPath: string;
  try {
    requestedPath = resolveLocalPathInput(options.filePath, "file path");
  } catch (error) {
    if (isWindowsPathAliasError(error)) return null;
    throw error;
  }

  return { label, rootDirs, requestedPath };
}

export function resolveLocalPathFromRootsSync(
  options: ResolveLocalPathFromRootsSyncOptions,
): LocalRootsPathResult | null {
  const input = prepareLocalRootsInput(options);
  if (!input) return null;
  const { label, rootDirs, requestedPath } = input;
  for (const rootDir of rootDirs) {
    const rootReal = resolveRootRealSync(rootDir);
    if (!rootReal) {
      continue;
    }

    let candidate: ReturnType<typeof resolveRootPathSync>;
    try {
      candidate = resolveRootPathSync({
        absolutePath: requestedPath,
        rootPath: rootDir,
        rootCanonicalPath: rootReal,
        boundaryLabel: label,
        rejectUnresolvedSymlinks: true,
        policy: options.requireFile ? ROOT_PATH_ALIAS_POLICIES.unlinkTarget : undefined,
      });
    } catch {
      continue;
    }
    if (!candidate.exists && options.allowMissing !== true) {
      continue;
    }
    if (candidate.exists && options.requireFile === true && candidate.kind !== "file") continue;
    if (candidate.exists && options.requireFile === true) {
      try {
        if (!fsSync.lstatSync(pathForWindowsFilesystem(requestedPath)).isFile()) continue;
      } catch { continue; }
    }
    return { path: candidate.canonicalPath, root: rootReal };
  }

  return null;
}

export async function readLocalFileFromRoots(
  options: ReadLocalFileFromRootsOptions,
): Promise<LocalRootsReadResult | null> {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const input = prepareLocalRootsInput(options);
  if (!input || input.rootDirs.length === 0) return null;
  const { rootDirs, requestedPath } = input;
  const readOptions: Parameters<Awaited<ReturnType<typeof root>>["read"]>[1] = {
    hardlinks: options.hardlinks,
    symlinks: options.symlinks,
  };
  // Omission keeps Root's default cap; one policy snapshot serves every root.
  if (maxBytes !== undefined) readOptions.maxBytes = maxBytes;

  for (const rootDir of rootDirs) {
    let scopedRoot: Awaited<ReturnType<typeof root>>;
    try {
      scopedRoot = await root(rootDir);
    } catch {
      continue;
    }

    try {
      const result = await scopedRoot.readAbsolute(requestedPath, readOptions);
      return { ...result, root: scopedRoot.rootReal };
    } catch {
      // Root handles both trusted spellings; try the next configured root.
    }
  }

  return null;
}
