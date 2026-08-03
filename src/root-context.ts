import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { expandHomePrefix } from "./home-dir.js";
import {
  assertNoNulPathInput,
  assertNoUnsafeDeviceReadPath,
  hasNodeErrorCode,
  isNotFoundPathError,
  isPathInside,
} from "./path.js";
import { ROOT_PATH_ALIAS_POLICIES, resolveRootPath } from "./root-path.js";
import { outsideWorkspaceError } from "./root-errors.js";
import { isDriveRelativePath } from "./safe-path-segment.js";

export type RootContext = {
  rootDir: string;
  rootIdentity: { dev: number; ino: number };
  rootReal: string;
  rootWithSep: string;
};

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

export async function expandRelativePathWithHome(relativePath: string): Promise<string> {
  const rawHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (cachedHomePath?.raw !== rawHome) {
    let realHome = rawHome;
    try {
      realHome = await fs.realpath(rawHome);
    } catch {
      // If the home dir cannot be canonicalized, keep lexical expansion behavior.
    }
    cachedHomePath = { raw: rawHome, real: realHome };
  }
  return expandHomePrefix(relativePath, { home: cachedHomePath.real });
}

export async function resolveRootContext(rootDir: string): Promise<RootContext> {
  assertNoNulPathInput(rootDir, "root dir contains a NUL byte");
  let rootReal: string;
  let rootIdentity: { dev: number; ino: number };
  try {
    rootReal = await fs.realpath(rootDir);
    const rootStat = await fs.stat(rootReal);
    if (!rootStat.isDirectory()) {
      throw new FsSafeError("invalid-path", "root dir is not a directory");
    }
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
    rootDir: path.resolve(rootDir),
    rootIdentity,
    rootReal,
    rootWithSep: ensureTrailingSep(rootReal),
  };
}

export async function resolvePathInRoot(
  root: RootContext,
  relativePath: string,
  options?: {
    aliasErrorCode?: "outside-workspace" | "path-alias";
    allowFinalSymlink?: boolean;
    rejectUnsafeDeviceReads?: boolean;
    rejectSymlinks?: boolean;
  },
): Promise<{ rootReal: string; rootWithSep: string; resolved: string }> {
  assertValidRootRelativePath(relativePath);
  const expanded = await expandRelativePathWithHome(relativePath);
  const resolved = path.resolve(root.rootWithSep, expanded);
  if (!isPathInside(root.rootWithSep, resolved)) {
    throw outsideWorkspaceError();
  }
  if (options?.rejectUnsafeDeviceReads === true) {
    assertNoUnsafeDeviceReadPath(resolved);
  }
  const rawAbsolutePath = path.isAbsolute(expanded)
    ? expanded
    : `${root.rootWithSep}${expanded}`;
  try {
    await resolveRootPath({
      absolutePath: rawAbsolutePath,
      rootPath: root.rootReal,
      rootCanonicalPath: root.rootReal,
      boundaryLabel: "root",
      policy: options?.allowFinalSymlink ? ROOT_PATH_ALIAS_POLICIES.unlinkTarget : undefined,
      rejectSymlinks: options?.rejectSymlinks,
    });
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
