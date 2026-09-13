import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sameFileIdentity } from "./file-identity.js";
import { guardedRenameSync, guardedRmSync } from "./guarded-mutation.js";
import { realpathSync } from "./realpath.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import {
  hasWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export type MovePathToTrashOptions = {
  allowedRoots?: Iterable<string>;
};

const TRASH_DESTINATION_COLLISION_CODES = new Set(["EEXIST", "ENOTEMPTY", "ERR_FS_CP_EEXIST"]);
const TRASH_DESTINATION_RETRY_LIMIT = 4;

function getFsErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function isTrashDestinationCollision(error: unknown): boolean {
  const code = getFsErrorCode(error);
  return Boolean(code && TRASH_DESTINATION_COLLISION_CODES.has(code));
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
}

function assertNoTrashPathAlias(value: string, label: string): void {
  if (hasWindowsPathAlias(value, "filesystem")) {
    throw new Error(`Refusing to trash ${label} using a Windows filesystem namespace alias: ${value}`);
  }
}

function collectAllowedTrashRoots(allowedRoots?: Iterable<string>): string[] {
  const roots = [...(allowedRoots ?? [os.homedir(), os.tmpdir()])];
  for (const root of roots) assertNoTrashPathAlias(root, "allowed root");
  return roots;
}

function resolveAllowedTrashRoots(allowedRoots: readonly string[]): string[] {
  const roots = allowedRoots.flatMap((root) => {
    assertNoTrashPathAlias(root, "allowed root");
    const lexicalRoot = resolvePathPreservingWindowsRoot(root);
    assertNoTrashPathAlias(lexicalRoot, "allowed root");
    let realRoot: string;
    try {
      // Keep both spellings: broken symlink targets cannot be realpathed and
      // may only compare equal to the caller's lexical allowed root.
      realRoot = realpathSync.native(root);
    } catch {
      return [lexicalRoot];
    }
    assertNoTrashPathAlias(realRoot, "allowed root");
    const resolvedRealRoot = resolvePathPreservingWindowsRoot(realRoot);
    assertNoTrashPathAlias(resolvedRealRoot, "allowed root");
    return [resolvedRealRoot, lexicalRoot];
  });
  return [...new Set(roots)];
}

type TrashTargetGuard = {
  path: string;
  realPath: string;
  realPathResolved: boolean;
  stat: fs.Stats;
};

function resolveTrashTargetPath(targetPath: string): { path: string; resolved: boolean } {
  assertNoTrashPathAlias(targetPath, "target path");
  let realPath: string;
  try {
    realPath = realpathSync.native(targetPath);
  } catch {
    // Broken symlinks are valid trash targets. Fall back to the lexical path,
    // then rely on lstat identity so the move renames the symlink itself.
    const lexicalPath = path.resolve(targetPath);
    assertNoTrashPathAlias(lexicalPath, "target path");
    return { path: lexicalPath, resolved: false };
  }
  const resolvedPath = path.resolve(realPath);
  assertNoTrashPathAlias(resolvedPath, "target path");
  return { path: resolvedPath, resolved: true };
}

function assertAllowedTrashTarget(
  targetPath: string,
  allowedRoots: readonly string[],
): TrashTargetGuard {
  assertNoTrashPathAlias(targetPath, "target path");
  const lexicalTarget = path.resolve(targetPath);
  assertNoTrashPathAlias(lexicalTarget, "target path");
  const stat = fs.lstatSync(lexicalTarget);
  const resolvedTarget = resolveTrashTargetPath(targetPath);
  const resolvedTargetPath = resolvedTarget.path;
  const isAllowed = resolveAllowedTrashRoots(allowedRoots).some(
    (root) => resolvedTargetPath !== root && isSameOrChildPath(resolvedTargetPath, root),
  );
  if (!isAllowed) {
    throw new Error(`Refusing to trash path outside allowed roots: ${targetPath}`);
  }
  return {
    path: lexicalTarget,
    realPath: resolvedTargetPath,
    realPathResolved: resolvedTarget.resolved,
    stat,
  };
}

function assertTrashTargetGuard(guard: TrashTargetGuard): void {
  const stat = fs.lstatSync(guard.path);
  if (!sameFileIdentity(stat, guard.stat)) {
    throw new Error(`Refusing to trash path after it changed: ${guard.path}`);
  }
  const current = resolveTrashTargetPath(guard.path);
  if (guard.realPathResolved && (!current.resolved || current.path !== guard.realPath)) {
    throw new Error(`Refusing to trash path after it changed: ${guard.path}`);
  }
  if (!guard.realPathResolved && current.resolved) {
    throw new Error(`Refusing to trash path after it changed: ${guard.path}`);
  }
}

function resolveTrashDir(): string {
  const homeDir = os.homedir();
  assertNoTrashPathAlias(homeDir, "home directory");
  const trashDir = path.join(homeDir, ".Trash");
  assertNoTrashPathAlias(trashDir, "trash directory");
  fs.mkdirSync(recursiveMkdirPath(trashDir), { recursive: true, mode: 0o700 });
  const trashDirStat = fs.lstatSync(trashDir);
  if (!trashDirStat.isDirectory() || trashDirStat.isSymbolicLink()) {
    throw new Error(`Refusing to use non-directory/symlink trash directory: ${trashDir}`);
  }
  const realHome = path.resolve(realpathSync.native(homeDir));
  const resolvedTrashDir = path.resolve(realpathSync.native(trashDir));
  assertNoTrashPathAlias(realHome, "home directory");
  assertNoTrashPathAlias(resolvedTrashDir, "trash directory");
  if (resolvedTrashDir === realHome || !isSameOrChildPath(resolvedTrashDir, realHome)) {
    throw new Error(`Trash directory escaped home directory: ${trashDir}`);
  }
  return resolvedTrashDir;
}

function trashBaseName(targetPath: string): string {
  assertNoTrashPathAlias(targetPath, "target path");
  const resolvedTargetPath = path.resolve(targetPath);
  assertNoTrashPathAlias(resolvedTargetPath, "target path");
  if (resolvedTargetPath === path.parse(resolvedTargetPath).root) {
    throw new Error(`Refusing to trash root path: ${targetPath}`);
  }
  const base = path.basename(resolvedTargetPath).replace(/[\\/]+/g, "");
  if (!base) {
    throw new Error(`Unable to derive safe trash basename for: ${targetPath}`);
  }
  return base;
}

function resolveContainedPath(root: string, leaf: string): string {
  assertNoTrashPathAlias(root, "destination root");
  assertNoTrashPathAlias(leaf, "destination name");
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, leaf);
  assertNoTrashPathAlias(resolvedRoot, "destination root");
  assertNoTrashPathAlias(resolvedPath, "destination path");
  if (!isSameOrChildPath(resolvedPath, resolvedRoot) || resolvedPath === resolvedRoot) {
    throw new Error(`Trash destination escaped trash directory: ${resolvedPath}`);
  }
  return resolvedPath;
}

function reserveTrashDestination(trashDir: string, base: string, timestamp: number): string {
  assertNoTrashPathAlias(trashDir, "trash directory");
  assertNoTrashPathAlias(base, "destination name");
  const containerPrefix = resolveContainedPath(trashDir, `.fs-safe-trash-${timestamp}-`);
  const container = fs.mkdtempSync(containerPrefix);
  const resolvedContainer = path.resolve(container);
  const resolvedTrashDir = path.resolve(trashDir);
  assertNoTrashPathAlias(resolvedContainer, "destination container");
  assertNoTrashPathAlias(resolvedTrashDir, "trash directory");
  if (
    resolvedContainer === resolvedTrashDir ||
    !isSameOrChildPath(resolvedContainer, resolvedTrashDir)
  ) {
    throw new Error(`Trash destination escaped trash directory: ${container}`);
  }
  return resolveContainedPath(container, base);
}

function copyTrashTargetSync(target: TrashTargetGuard, dest: string): void {
  if (target.stat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(target.path);
    assertNoTrashPathAlias(linkTarget, "symlink target");
    assertTrashTargetGuard(target);
    fs.symlinkSync(linkTarget, dest);
    return;
  }
  fs.cpSync(target.path, dest, { recursive: true, force: false, errorOnExist: true });
}

function movePathToDestination(target: TrashTargetGuard, dest: string): boolean {
  getFsSafeTestHooks()?.beforeTrashMove?.(target.path, dest);
  assertTrashTargetGuard(target);
  try {
    guardedRenameSync({ from: target.path, to: dest });
    return true;
  } catch (error) {
    if (getFsErrorCode(error) !== "EXDEV") {
      if (isTrashDestinationCollision(error)) {
        return false;
      }
      throw error;
    }
  }

  try {
    assertTrashTargetGuard(target);
    copyTrashTargetSync(target, dest);
    assertTrashTargetGuard(target);
    guardedRmSync({ target: target.path, recursive: true, force: false, verifyAfter: false });
    return true;
  } catch (error) {
    if (isTrashDestinationCollision(error)) {
      return false;
    }
    throw error;
  }
}

export async function movePathToTrash(
  targetPath: string,
  options: MovePathToTrashOptions = {},
): Promise<string> {
  // Avoid resolving external trash helpers through the service PATH during cleanup.
  assertNoTrashPathAlias(targetPath, "target path");
  const allowedRoots = collectAllowedTrashRoots(options.allowedRoots);
  const base = trashBaseName(targetPath);
  const target = assertAllowedTrashTarget(targetPath, allowedRoots);
  const trashDir = resolveTrashDir();
  const timestamp = Date.now();
  for (let attempt = 0; attempt < TRASH_DESTINATION_RETRY_LIMIT; attempt += 1) {
    const dest = reserveTrashDestination(trashDir, base, timestamp);
    if (movePathToDestination(target, dest)) {
      return dest;
    }
  }

  throw new Error(`Unable to choose a unique trash destination for ${targetPath}`);
}
