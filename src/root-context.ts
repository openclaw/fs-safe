import fs, { type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extendDirectoryObservationGuard,
  inspectDirectoryIdentity,
  inspectDirectoryObservationSync,
  type AsyncDirectoryGuard,
  type DirectoryObservationGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import {
  assertNoNulPathInput,
  assertNoUnsafeDeviceReadPath,
  hasNodeErrorCode,
  isNotFoundPathError,
  isPathInside,
} from "./path.js";
import { ROOT_PATH_ALIAS_POLICIES, resolveRootPath } from "./root-path.js";
import { outsideWorkspaceError, rootPathChangedError } from "./root-errors.js";
import { isDriveRelativePath } from "./safe-path-segment.js";
import { realpathSync } from "./realpath.js";
import { inspectFileIdentity } from "./strict-file-identity.js";

export type RootContext = {
  rootDir: string;
  rootGuard?: AsyncDirectoryGuard<BigIntStats>;
  rootIdentity: { dev: number; ino: number } | { dev: bigint; ino: bigint };
  rootReal: string;
  rootWithSep: string;
};

function hasExactRootIdentity(
  identity: RootContext["rootIdentity"],
): identity is { dev: bigint; ino: bigint } {
  return typeof identity.dev === "bigint" && typeof identity.ino === "bigint";
}

export const ensureTrailingSep = (value: string) =>
  value.endsWith(path.sep) ? value : value + path.sep;

export function assertValidRootRelativePath(relativePath: string): void {
  assertNoNulPathInput(relativePath, "relative path contains a NUL byte");
}

export function assertValidRootDestinationPath(relativePath: string): void {
  assertValidRootRelativePath(relativePath);
  if (isDriveRelativePath(relativePath)) {
    throw new FsSafeError("invalid-path", "relative path must not start with a drive letter");
  }
}

let cachedHomePath: { raw: string; real: string } | undefined;
const POSIX_PARENT_COMPONENT = /(?:^|\/)\.\.(?:\/|$)/;
const WINDOWS_PARENT_COMPONENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

export async function expandRelativePathWithHome(relativePath: string): Promise<string> {
  const homeOnly = relativePath === "~";
  const homePrefix = relativePath.startsWith("~/") || (path.sep === "\\" && relativePath.startsWith("~\\"));
  if (!homeOnly && !homePrefix) return relativePath;
  const rawHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (cachedHomePath?.raw !== rawHome) {
    let realHome = rawHome;
    try {
      realHome = realpathSync.native(rawHome);
    } catch {
      // If the home dir cannot be canonicalized, keep lexical expansion behavior.
    }
    cachedHomePath = { raw: rawHome, real: realHome };
  }
  return homeOnly ? cachedHomePath.real : `${ensureTrailingSep(cachedHomePath.real)}${relativePath.slice(2)}`;
}

export async function resolveRootContext(rootDir: string): Promise<RootContext> {
  assertNoNulPathInput(rootDir, "root dir contains a NUL byte");
  const lexicalRoot = path.resolve(rootDir);
  let rootReal: string;
  let rootStat: BigIntStats;
  let rootIdentity: { dev: bigint; ino: bigint };
  try {
    rootReal = realpathSync.native(rootDir);
    rootStat = await inspectFileIdentity(() => {
      const stat = fs.statSync(rootReal, { bigint: true });
      if (!stat.isDirectory()) throw new FsSafeError("invalid-path", "root dir is not a directory");
      return stat;
    });
    rootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
  } catch (err) {
    if (err instanceof FsSafeError) {
      throw err;
    }
    if (isNotFoundPathError(err)) {
      throw new FsSafeError("not-found", "root dir not found");
    }
    throw err;
  }
  return {
    rootDir: lexicalRoot,
    rootGuard: { dir: rootReal, realPath: rootReal, stat: rootStat },
    rootIdentity,
    rootReal,
    rootWithSep: ensureTrailingSep(rootReal),
  };
}

export function rootRelativeReadPath(root: RootContext, filePath: string): string {
  const absoluteInput = path.isAbsolute(filePath);
  if (!absoluteInput) return filePath;
  const raw = process.platform === "win32" ? filePath.replaceAll("/", path.sep) : filePath;
  for (const base of [root.rootDir, root.rootReal]) {
    const prefix = ensureTrailingSep(base);
    const matches = process.platform === "win32"
      ? raw.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
      : raw.startsWith(prefix);
    if (matches) {
      let start = prefix.length;
      while (raw[start] === path.sep) start += 1;
      return raw.slice(start);
    }
  }
  return raw;
}

export async function assertRootIdentityCurrent(root: RootContext): Promise<void> {
  let current: fs.Stats;
  try {
    if (typeof root.rootIdentity.dev === "bigint" && typeof root.rootIdentity.ino === "bigint") {
      await inspectDirectoryIdentity(root.rootReal, { dev: root.rootIdentity.dev, ino: root.rootIdentity.ino });
      return;
    }
    current = fs.lstatSync(root.rootReal);
  } catch (error) {
    throw rootPathChangedError(error instanceof Error ? error : undefined);
  }
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameFileIdentity(current, root.rootIdentity)
  ) {
    throw rootPathChangedError();
  }
}

/**
 * Observe the current Root with an exact, operation-local receipt.
 *
 * This is deliberately separate from {@link assertRootIdentityCurrent}: callers
 * must not retain the returned guard beyond the operation that requested it.
 */
export async function createRootObservationGuard(
  root: RootContext,
): Promise<DirectoryObservationGuard | undefined> {
  const rootIdentity = root.rootIdentity;
  if (!hasExactRootIdentity(rootIdentity)) {
    await assertRootIdentityCurrent(root);
    return undefined;
  }
  try {
    const observed = await inspectDirectoryObservationSync(root.rootReal, rootIdentity);
    return extendDirectoryObservationGuard(observed, root.rootReal, root.rootReal);
  } catch (error) {
    throw rootPathChangedError(error instanceof Error ? error : undefined);
  }
}

export async function resolvePathInRoot(
  root: RootContext,
  relativePath: string,
  options?: {
    aliasErrorCode?: "outside-workspace" | "path-alias";
    allowFinalSymlink?: boolean;
    rejectUnsafeDeviceReads?: boolean;
    rejectSymlinks?: boolean;
    rejectFinalSymlink?: boolean;
    resolveCanonical?: boolean;
    rejectAmbiguousParents?: boolean;
  },
): Promise<{ rootReal: string; rootWithSep: string; resolved: string }> {
  assertValidRootRelativePath(relativePath);
  await assertRootIdentityCurrent(root);
  const expanded = await expandRelativePathWithHome(relativePath);
  let resolved = path.resolve(root.rootWithSep, expanded);
  if (!options?.resolveCanonical && !isPathInside(root.rootWithSep, resolved)) {
    throw outsideWorkspaceError();
  }
  if (options?.rejectUnsafeDeviceReads === true) {
    assertNoUnsafeDeviceReadPath(resolved);
  }
  const rawAbsolutePath = path.isAbsolute(expanded)
    ? expanded
    : `${root.rootWithSep}${expanded}`;
  try {
    const resolution = {
      absolutePath: rawAbsolutePath,
      rootPath: root.rootReal,
      rootCanonicalPath: root.rootReal,
      boundaryLabel: "root",
      policy: options?.allowFinalSymlink ? ROOT_PATH_ALIAS_POLICIES.unlinkTarget : undefined,
      rejectSymlinks: options?.rejectSymlinks,
      rejectFinalSymlink: options?.rejectFinalSymlink,
    };
    const checked = await resolveRootPath(resolution);
    const parentComponent = process.platform === "win32" ? WINDOWS_PARENT_COMPONENT : POSIX_PARENT_COMPONENT;
    if (options?.rejectAmbiguousParents && parentComponent.test(expanded) &&
      path.relative(checked.canonicalPath, resolved) !== "") {
      const normalized = await resolveRootPath({ ...resolution, absolutePath: resolved });
      if (path.relative(checked.canonicalPath, normalized.canonicalPath) !== "") {
        throw new FsSafeError("path-alias", "parent traversal resolves differently through a symlink");
      }
    }
    if (options?.resolveCanonical) resolved = checked.canonicalPath;
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "symlink") {
      throw error;
    }
    if (hasNodeErrorCode(error, "ENAMETOOLONG")) {
      throw new FsSafeError("invalid-path", "relative path is too long", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    const code = options?.aliasErrorCode ?? "outside-workspace";
    throw new FsSafeError(
      code,
      code === "path-alias" ? "path alias escape blocked" : "file is outside workspace root",
      {
        cause: error instanceof Error ? error : undefined,
      },
    );
  }
  return { rootReal: root.rootReal, rootWithSep: root.rootWithSep, resolved };
}

export async function resolvePathWithinRoot(params: {
  rootDir: string;
  relativePath: string;
}): Promise<{ rootReal: string; rootWithSep: string; resolved: string }> {
  return await resolvePathInRoot(await resolveRootContext(params.rootDir), params.relativePath);
}
