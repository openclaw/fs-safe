import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { expandHomePrefix, resolveUserPath } from "./home-dir.js";
import { isFileUrl, safeFileURLToPath } from "./local-file-access.js";
import { isPathInside } from "./path.js";
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
  return resolveUserPath(input);
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

function isPathInsideRoot(candidate: string, rootDir: string): boolean {
  return isPathInside(rootDir, candidate);
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

function resolveCandidateCanonicalSync(
  filePath: string,
): { exists: true; canonicalPath: string; isFile: boolean } | { exists: false; canonicalPath: string } {
  let sawExistingLeaf = false;
  try {
    const stat = fsSync.lstatSync(filePath);
    sawExistingLeaf = true;
    return {
      exists: true,
      canonicalPath: fsSync.realpathSync(filePath),
      isFile: stat.isFile(),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  if (sawExistingLeaf) {
    // lstat succeeded but realpath failed: this is an existing dangling
    // symlink, not a missing path callers may safely create through.
    throw new FsSafeError("symlink", "local roots candidate is a dangling symlink");
  }

  let cursor = filePath;
  const missingSegments: string[] = [];
  while (true) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return { exists: false, canonicalPath: filePath };
    }
    missingSegments.unshift(path.basename(cursor));
    cursor = parent;
    try {
      fsSync.lstatSync(cursor);
      const ancestorReal = fsSync.realpathSync(cursor);
      return {
        exists: false,
        canonicalPath: path.join(ancestorReal, ...missingSegments),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Existing ancestors that cannot be canonicalized are symlink/error
        // terrain; do not reconstruct a trusted missing path through them.
        throw err;
      }
    }
  }
}

export function resolveLocalPathFromRootsSync(
  options: ResolveLocalPathFromRootsSyncOptions,
): LocalRootsPathResult | null {
  const label = options.label ?? "local roots";
  const requestedPath = path.resolve(resolveLocalPathInput(options.filePath, "file path"));
  const rootDirs = options.roots.map((rootEntry) => resolveLocalRootInput(rootEntry, label));

  for (const rootDir of rootDirs) {
    const rootReal = resolveRootRealSync(rootDir);
    if (!rootReal) {
      continue;
    }

    let candidate: ReturnType<typeof resolveCandidateCanonicalSync>;
    try {
      candidate = resolveCandidateCanonicalSync(requestedPath);
    } catch {
      continue;
    }
    if (!candidate.exists && options.allowMissing !== true) {
      continue;
    }
    if (candidate.exists && options.requireFile === true && !candidate.isFile) {
      continue;
    }
    if (isPathInsideRoot(candidate.canonicalPath, rootReal)) {
      return { path: candidate.canonicalPath, root: rootReal };
    }
  }

  return null;
}

export async function readLocalFileFromRoots(
  options: ReadLocalFileFromRootsOptions,
): Promise<LocalRootsReadResult | null> {
  const label = options.label ?? "local roots";
  const requestedPath = path.resolve(resolveLocalPathInput(options.filePath, "file path"));
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
      nonBlockingRead: options.nonBlockingRead,
      symlinks: options.symlinks,
    };
    // Leave maxBytes absent when the caller omits it so Root's own default
    // cap remains in force instead of being overwritten by undefined.
    if (options.maxBytes !== undefined) {
      readOptions.maxBytes = options.maxBytes;
    }

    // A trusted root symlink has two valid spellings. Preserve the caller's
    // lexical spelling when possible so Root.read() still enforces its
    // symlink policy, while also accepting a path expressed below rootReal.
    const relativePaths = [scopedRoot.rootDir, scopedRoot.rootReal]
      .filter((rootPath, index, roots) => roots.indexOf(rootPath) === index)
      .filter((rootPath) => isPathInside(rootPath, requestedPath))
      .map((rootPath) => path.relative(rootPath, requestedPath))
      .filter(Boolean);
    for (const relativePath of relativePaths) {
      try {
        const result = await scopedRoot.read(relativePath, readOptions);
        return { ...result, root: scopedRoot.rootReal };
      } catch {
        // Try the canonical spelling before moving to the next configured root.
      }
    }
  }

  return null;
}
