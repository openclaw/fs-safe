import fs, { type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extendDirectoryObservationGuard,
  inspectDirectoryIdentitySync,
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
import { admitPathInsideRoot } from "./root-boundary.js";
import { errorCauseOptions, outsideWorkspaceError, rootPathChangedError } from "./root-errors.js";
import { isDriveRelativePath } from "./safe-path-segment.js";
import { realpathSync } from "./realpath.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import {
  assertNoWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathFromBasePreservingWindowsRoot,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

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
  assertNoWindowsPathAlias(
    relativePath,
    "filesystem",
    "relative path uses a Windows filesystem namespace alias",
  );
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
  if (!homeOnly && !homePrefix) {
    assertNoWindowsPathAlias(relativePath, "filesystem", "relative path uses a Windows filesystem namespace alias");
    return relativePath;
  }
  const rawHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
  assertNoWindowsPathAlias(rawHome, "filesystem", "home path uses a Windows filesystem namespace alias");
  if (cachedHomePath?.raw !== rawHome) {
    let realHome = rawHome;
    try {
      realHome = realpathSync.native(pathForWindowsFilesystem(rawHome));
    } catch {
      // If the home dir cannot be canonicalized, keep lexical expansion behavior.
    }
    cachedHomePath = { raw: rawHome, real: realHome };
  }
  if (homeOnly) {
    assertNoWindowsPathAlias(cachedHomePath.real, "filesystem", "home path uses a Windows filesystem namespace alias");
    return cachedHomePath.real;
  }
  const expanded = `${ensureTrailingSep(cachedHomePath.real)}${relativePath.slice(2)}`;
  assertNoWindowsPathAlias(expanded, "filesystem", "expanded path uses a Windows filesystem namespace alias");
  return expanded;
}

export async function resolveRootContext(rootDir: string): Promise<RootContext> {
  assertNoNulPathInput(rootDir, "root dir contains a NUL byte");
  assertNoWindowsPathAlias(rootDir, "filesystem", "root dir uses a Windows filesystem namespace alias");
  const lexicalRoot = resolvePathPreservingWindowsRoot(rootDir);
  assertNoWindowsPathAlias(lexicalRoot, "filesystem", "root dir uses a Windows filesystem namespace alias");
  let rootReal: string;
  let rootStat: BigIntStats;
  let rootIdentity: { dev: bigint; ino: bigint };
  try {
    rootReal = realpathSync.native(pathForWindowsFilesystem(rootDir));
    assertNoWindowsPathAlias(rootReal, "filesystem", "canonical root path uses a Windows filesystem namespace alias");
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
  const bases = root.rootDir === root.rootReal ? [root.rootReal] : [root.rootDir, root.rootReal];
  for (const base of bases) {
    if (process.platform === "win32") {
      const admitted = admitPathInsideRoot({
        rootPath: base,
        candidatePath: raw,
        rootIdentity: root.rootIdentity,
        resolveCandidateRoot: base === root.rootDir && root.rootDir !== root.rootReal,
      });
      if (admitted) return admitted.relativePath;
      continue;
    }
    const prefix = ensureTrailingSep(base);
    const matches = raw.startsWith(prefix);
    if (matches) {
      let start = prefix.length;
      while (raw[start] === path.sep) start += 1;
      return raw.slice(start);
    }
  }
  return raw;
}

export function assertRootIdentityCurrentSync(
  root: RootContext,
  observe?: (stat: fs.BigIntStats) => void,
): void {
  let current: fs.Stats;
  try {
    if (typeof root.rootIdentity.dev === "bigint" && typeof root.rootIdentity.ino === "bigint") {
      const stat = inspectDirectoryIdentitySync(root.rootReal, { dev: root.rootIdentity.dev, ino: root.rootIdentity.ino });
      observe?.(stat);
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

export async function assertRootIdentityCurrent(
  root: RootContext,
  observe?: (stat: fs.BigIntStats) => void,
): Promise<void> {
  assertRootIdentityCurrentSync(root, observe);
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
  assertNoWindowsPathAlias(expanded, "filesystem", "expanded path uses a Windows filesystem namespace alias");
  let resolved = resolvePathFromBasePreservingWindowsRoot(root.rootWithSep, expanded);
  assertNoWindowsPathAlias(resolved, "filesystem", "resolved path uses a Windows filesystem namespace alias");
  if (!options?.resolveCanonical && !isPathInside(root.rootWithSep, resolved)) {
    throw outsideWorkspaceError();
  }
  if (options?.rejectUnsafeDeviceReads === true) {
    assertNoUnsafeDeviceReadPath(resolved);
  }
  const rawAbsolutePath = path.isAbsolute(expanded)
    ? expanded
    : `${root.rootWithSep}${expanded}`;
  assertNoWindowsPathAlias(rawAbsolutePath, "filesystem", "resolved path uses a Windows filesystem namespace alias");
  try {
    const resolution = {
      absolutePath: rawAbsolutePath,
      rootPath: root.rootReal,
      rootCanonicalPath: root.rootReal,
      rootIdentity: root.rootIdentity,
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
    if (options?.resolveCanonical) {
      resolved = checked.canonicalPath;
    } else {
      // resolveRootPath preserves ordinary caller spelling as part of its
      // public receipt. Re-admit the exact normalized spelling before it is
      // reused for Root I/O: on a case-sensitive Windows directory it may
      // otherwise name a distinct case-folded sibling after raw traversal.
      const admitted = admitPathInsideRoot({
        rootPath: root.rootReal,
        candidatePath: checked.absolutePath,
        rootIdentity: root.rootIdentity,
      });
      if (!admitted) throw outsideWorkspaceError();
      resolved = admitted.path;
    }
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "symlink") {
      throw error;
    }
    if (hasNodeErrorCode(error, "ENAMETOOLONG")) {
      throw new FsSafeError("invalid-path", "relative path is too long", errorCauseOptions(error));
    }
    const code = options?.aliasErrorCode ?? "outside-workspace";
    throw new FsSafeError(
      code,
      code === "path-alias" ? "path alias escape blocked" : "file is outside workspace root",
      errorCauseOptions(error),
    );
  }
  return { rootReal: root.rootReal, rootWithSep: root.rootWithSep, resolved };
}
