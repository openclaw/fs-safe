import fsSync from "node:fs";
import path from "node:path";
import { normalizeMaxBytes } from "./byte-budget.js";
import { FsSafeError } from "./errors.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "./home-dir.js";
import { isFileUrl, safeFileURLToPath } from "./local-file-access.js";
import { ROOT_PATH_ALIAS_POLICIES, resolveRootPathSync } from "./root-path.js";
import { root, type HardlinkPolicy, type ReadResult, type SymlinkPolicy } from "./root.js";

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

export type ReadLocalFileFromRootsOptions = LocalRootsInputOptions & {
  hardlinks?: HardlinkPolicy;
  maxBytes?: number;
  nonBlockingRead?: boolean;
  symlinks?: SymlinkPolicy;
};

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
  const homePrefix = input === "~" || input.startsWith("~/") ||
    (path.sep === "\\" && input.startsWith("~\\"));
  const expanded = homePrefix ? `${resolveRequiredHomeDir()}${path.sep}${input.slice(2)}` : input;
  if (path.isAbsolute(expanded)) return expanded;
  const drive = path.parse(expanded).root;
  const base = drive ? path.resolve(drive) : process.cwd();
  return `${base}${path.sep}${expanded.slice(drive.length)}`;
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
  if (!path.isAbsolute(resolved)) {
    throw new FsSafeError("invalid-path", `${label} entries must be absolute paths: ${input}`);
  }
  return path.resolve(resolved);
}

function resolveRootRealSync(rootDir: string): string | null {
  try {
    // Configured roots may themselves be symlinks. Follow only this trusted
    // root entry, then use its canonical directory for containment checks.
    const stat = fsSync.statSync(rootDir);
    if (!stat.isDirectory()) {
      return null;
    }
    return fsSync.realpathSync(rootDir);
  } catch {
    return null;
  }
}

export function resolveLocalPathFromRootsSync(
  options: ResolveLocalPathFromRootsSyncOptions,
): LocalRootsPathResult | null {
  const label = options.label ?? "local roots";
  const requestedPath = resolveLocalPathInput(options.filePath, "file path");
  const rootDirs = options.roots.map((rootEntry) => resolveLocalRootInput(rootEntry, label));

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
    return { path: candidate.canonicalPath, root: rootReal };
  }

  return null;
}

export async function readLocalFileFromRoots(
  options: ReadLocalFileFromRootsOptions,
): Promise<LocalRootsReadResult | null> {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const label = options.label ?? "local roots";
  const requestedPath = resolveLocalPathInput(options.filePath, "file path");
  const rootDirs = options.roots.map((rootEntry) => resolveLocalRootInput(rootEntry, label));

  for (const rootDir of rootDirs) {
    let scopedRoot: Awaited<ReturnType<typeof root>>;
    try {
      scopedRoot = await root(rootDir);
    } catch {
      continue;
    }

    const readOptions: Parameters<typeof scopedRoot.read>[1] = {
      hardlinks: options.hardlinks,
      symlinks: options.symlinks,
    };
    // Leave maxBytes absent when the caller omits it so Root's own default
    // cap remains in force instead of being overwritten by undefined.
    if (maxBytes !== undefined) {
      readOptions.maxBytes = maxBytes;
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
