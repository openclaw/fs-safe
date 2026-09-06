import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type WalkEntryKind = "file" | "directory" | "symlink" | "other";
export type WalkSymlinkPolicy = "skip" | "follow" | "include";

export type WalkDirectoryEntry = {
  name: string;
  path: string;
  relativePath: string;
  depth: number;
  kind: WalkEntryKind;
  dirent: fsSync.Dirent;
};

export type WalkDirectoryOptions = {
  maxDepth?: number;
  maxEntries?: number;
  symlinks?: WalkSymlinkPolicy;
  include?: (entry: WalkDirectoryEntry) => boolean;
  descend?: (entry: WalkDirectoryEntry) => boolean;
};

export type WalkDirectoryFailure = {
  path: string;
  relativePath: string;
  depth: number;
  error: unknown;
};

export type WalkDirectoryResult = {
  entries: WalkDirectoryEntry[];
  scannedEntryCount: number;
  truncated: boolean;
  // Always present on values returned by the walkers. Optional so existing
  // callers can continue constructing the legacy result shape.
  failedDirs?: WalkDirectoryFailure[];
};

type WalkDirectoryResultWithFailures = WalkDirectoryResult & {
  failedDirs: WalkDirectoryFailure[];
};

function validateWalkBudget(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function validateWalkOptions(options: WalkDirectoryOptions): void {
  validateWalkBudget("maxDepth", options.maxDepth);
  validateWalkBudget("maxEntries", options.maxEntries);
  if (
    options.symlinks !== undefined &&
    !(["skip", "follow", "include"] as const).includes(options.symlinks)
  ) {
    throw new TypeError(`invalid walk symlink policy: ${String(options.symlinks)}`);
  }
}

function kindForDirent(dirent: fsSync.Dirent): WalkEntryKind {
  if (dirent.isDirectory()) return "directory";
  if (dirent.isFile()) return "file";
  if (dirent.isSymbolicLink()) return "symlink";
  return "other";
}

class WalkState {
  readonly root: string;
  readonly symlinks: WalkSymlinkPolicy;
  readonly result: WalkDirectoryResultWithFailures = {
    entries: [],
    scannedEntryCount: 0,
    truncated: false,
    failedDirs: [],
  };
  readonly visitedDirs = new Set<string>();

  constructor(rootDir: string, readonly options: WalkDirectoryOptions) {
    validateWalkOptions(options);
    this.root = path.resolve(rootDir);
    this.symlinks = options.symlinks ?? "skip";
  }

  recordFailure(dir: string, depth: number, error: unknown): void {
    const relativePath = path.relative(this.root, dir);
    this.result.failedDirs.push({
      path: dir,
      relativePath,
      depth: relativePath === "" ? 0 : depth - 1,
      error,
    });
  }

  scanEntry(): boolean {
    if (this.options.maxEntries !== undefined &&
      this.result.scannedEntryCount >= Math.max(0, this.options.maxEntries)) {
      this.result.truncated = true;
      return false;
    }
    this.result.scannedEntryCount += 1;
    return true;
  }

  collectEntry(dir: string, dirent: fsSync.Dirent, depth: number, kind: WalkEntryKind): boolean {
    const fullPath = path.join(dir, dirent.name);
    const relativePath = path.relative(this.root, fullPath) || dirent.name;
    const entry: WalkDirectoryEntry = {
      name: dirent.name,
      path: fullPath,
      relativePath,
      depth,
      kind,
      dirent,
    };
    if (this.options.include?.(entry) ?? true) {
      this.result.entries.push(entry);
    }
    return kind === "directory" &&
      (this.options.maxDepth === undefined || depth < this.options.maxDepth) &&
      (this.options.descend?.(entry) ?? true);
  }
}

function resolveSyncKind(fullPath: string, dirent: fsSync.Dirent, symlinks: WalkSymlinkPolicy): WalkEntryKind | null {
  const kind = kindForDirent(dirent);
  if (kind !== "symlink") return kind;
  if (symlinks === "skip") return null;
  if (symlinks === "include") return "symlink";
  try {
    const stat = fsSync.statSync(fullPath);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
  } catch {
    return null;
  }
  return "other";
}

async function resolveAsyncKind(fullPath: string, dirent: fsSync.Dirent, symlinks: WalkSymlinkPolicy): Promise<WalkEntryKind | null> {
  const kind = kindForDirent(dirent);
  if (kind !== "symlink") return kind;
  if (symlinks === "skip") return null;
  if (symlinks === "include") return "symlink";
  try {
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
  } catch {
    return null;
  }
  return "other";
}

export function walkDirectorySync(
  rootDir: string,
  options: WalkDirectoryOptions = {},
): WalkDirectoryResultWithFailures {
  const state = new WalkState(rootDir, options);
  const { root, symlinks, result, visitedDirs } = state;

  function visit(dir: string, depth: number): void {
    if (options.maxDepth !== undefined && depth > options.maxDepth) return;
    let realDir: string;
    try {
      realDir = fsSync.realpathSync(dir);
    } catch (error) {
      state.recordFailure(dir, depth, error);
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      state.recordFailure(dir, depth, error);
      return;
    }
    for (const dirent of entries) {
      if (!state.scanEntry()) return;
      const fullPath = path.join(dir, dirent.name);
      const kind = resolveSyncKind(fullPath, dirent, symlinks);
      if (!kind) continue;
      if (state.collectEntry(dir, dirent, depth, kind)) {
        visit(fullPath, depth + 1);
        if (result.truncated) return;
      }
    }
  }

  visit(root, 1);
  return result;
}

export async function walkDirectory(
  rootDir: string,
  options: WalkDirectoryOptions = {},
): Promise<WalkDirectoryResultWithFailures> {
  const state = new WalkState(rootDir, options);
  const { root, symlinks, result, visitedDirs } = state;

  async function visit(dir: string, depth: number): Promise<void> {
    if (options.maxDepth !== undefined && depth > options.maxDepth) return;
    let realDir: string;
    try {
      realDir = await fs.realpath(dir);
    } catch (error) {
      state.recordFailure(dir, depth, error);
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      state.recordFailure(dir, depth, error);
      return;
    }
    for (const dirent of entries) {
      if (!state.scanEntry()) return;
      const fullPath = path.join(dir, dirent.name);
      const kind = await resolveAsyncKind(fullPath, dirent, symlinks);
      if (!kind) continue;
      if (state.collectEntry(dir, dirent, depth, kind)) {
        await visit(fullPath, depth + 1);
        if (result.truncated) return;
      }
    }
  }

  await visit(root, 1);
  return result;
}
