import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertAsyncDirectoryGuard,
  createAsyncDirectoryGuard,
  type AnyAsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError, isPathRelativeEscape } from "./path.js";
import { directoryComponentNotDirectoryError, rootPathChangedError } from "./root-errors.js";
import {
  assertNoWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";
import { realpathSync } from "./realpath.js";
import { admitPathInsideRoot, type RootBoundaryIdentity } from "./root-boundary.js";

type ExactRootIdentity = Readonly<{ dev: bigint; ino: bigint }>;

function suppliedExactRootIdentity(identity: RootBoundaryIdentity | undefined): ExactRootIdentity | undefined {
  return typeof identity?.dev === "bigint" && typeof identity.ino === "bigint"
    ? { dev: identity.dev, ino: identity.ino }
    : undefined;
}

function assertGuardMatchesRootIdentity(
  guard: AnyAsyncDirectoryGuard,
  expected: ExactRootIdentity,
): void {
  if (guard.stat.dev !== expected.dev || guard.stat.ino !== expected.ino) {
    throw rootPathChangedError();
  }
}

async function realpathOrThrowNotFile(target: string): Promise<string> {
  try {
    const canonical = realpathSync.native(
      pathForWindowsFilesystem(target),
    );
    assertNoWindowsPathAlias(
      canonical,
      "filesystem",
      "canonical directory uses a Windows filesystem namespace alias",
    );
    return resolvePathPreservingWindowsRoot(canonical);
  } catch (error) {
    if (isNotFoundPathError(error)) {
      // A dangling symlink (or a component removed between lstat and
      // realpath) is not a usable directory component.
      throw directoryComponentNotDirectoryError(error instanceof Error ? error : undefined);
    }
    throw error;
  }
}

/**
 * Creates each missing path component from `rootReal` down to `targetPath`,
 * guarding every step. Returns the real (symlink-resolved) path of the final
 * component so callers can guard/use that path directly instead of
 * re-deriving it from the original, possibly-symlinked, lexical path.
 */
export async function mkdirPathComponentsWithGuards(params: {
  rootReal: string;
  targetPath: string;
  beforeComponent?: (componentPath: string) => Promise<void> | void;
  assertBeforeMutation?: () => void;
  mode?: number;
  rejectSymlinks?: boolean;
  rootIdentity?: RootBoundaryIdentity;
}): Promise<string> {
  const rawRootReal = params.rootReal;
  assertNoWindowsPathAlias(
    rawRootReal,
    "filesystem",
    "root directory uses a Windows filesystem namespace alias",
  );
  const rawTargetPath = params.targetPath;
  assertNoWindowsPathAlias(
    rawTargetPath,
    "filesystem",
    "target directory uses a Windows filesystem namespace alias",
  );
  const root = resolvePathPreservingWindowsRoot(rawRootReal);
  const target = resolvePathPreservingWindowsRoot(rawTargetPath);
  const suppliedIdentity = suppliedExactRootIdentity(params.rootIdentity);
  const configuredRootGuard = await createAsyncDirectoryGuard(root, { bigint: true });
  const checkedRootIdentity = suppliedIdentity ?? {
    dev: configuredRootGuard.stat.dev,
    ino: configuredRootGuard.stat.ino,
  };
  assertGuardMatchesRootIdentity(configuredRootGuard, checkedRootIdentity);
  assertNoWindowsPathAlias(configuredRootGuard.realPath);
  const rootCanonical = resolvePathPreservingWindowsRoot(configuredRootGuard.realPath);
  const rootGuard = rootCanonical === root
    ? configuredRootGuard
    : await createAsyncDirectoryGuard(rootCanonical, { bigint: true });
  assertGuardMatchesRootIdentity(rootGuard, checkedRootIdentity);

  const admissionParams = {
    candidatePath: target,
    rootIdentity: checkedRootIdentity,
  };
  // Derive the suffix from the caller's trusted root spelling first. The
  // canonical spelling is also accepted after both names have been bound to
  // the same exact root object above.
  const admittedTarget = admitPathInsideRoot({ rootPath: root, ...admissionParams }) ??
    (rootCanonical === root
      ? undefined
      : admitPathInsideRoot({ rootPath: rootCanonical, ...admissionParams }));
  if (!admittedTarget || isPathRelativeEscape(admittedTarget.relativePath)) {
    throw new FsSafeError("outside-workspace", "directory is outside workspace root");
  }
  let current = rootCanonical;
  let currentGuard: AnyAsyncDirectoryGuard = rootGuard;
  for (const part of admittedTarget.relativePath.split(path.sep).filter(Boolean)) {
    const next = path.join(current, part);
    const parentGuard = currentGuard;
    assertNoWindowsPathAlias(
      parentGuard.realPath,
      "filesystem",
      "canonical parent directory uses a Windows filesystem namespace alias",
    );
    await assertAsyncDirectoryGuard(parentGuard);
    await params.beforeComponent?.(next);
    params.assertBeforeMutation?.();
    try {
      await fs.mkdir(next, { mode: params.mode });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    const stat = fsSync.lstatSync(next);
    if ((params.rejectSymlinks && stat.isSymbolicLink()) || (!stat.isSymbolicLink() && !stat.isDirectory())) {
      throw directoryComponentNotDirectoryError();
    }
    // Node's recursive mkdir follows symlinks in missing components. Build one
    // segment at a time and realpath-check each segment before descending.
    const observedNextReal = await realpathOrThrowNotFile(next);
    const admittedNextReal = admitPathInsideRoot({
      rootPath: rootCanonical,
      candidatePath: observedNextReal,
      rootIdentity: checkedRootIdentity,
    });
    if (!admittedNextReal) {
      throw new FsSafeError("outside-workspace", "directory escaped workspace root");
    }
    const nextReal = admittedNextReal.path;
    if (stat.isSymbolicLink()) {
      // An existing path component may legitimately be a symlink to a real
      // directory inside the root (e.g. a skill-bank layout). We already
      // verified above that it resolves inside the root, so treat the
      // resolved real path as the directory for the rest of this walk
      // instead of rejecting it outright. Guard checks from here on operate
      // on the real (non-symlink) path, preserving TOCTOU protection for
      // every subsequent segment. Callers that need the final directory
      // (e.g. to guard it themselves after this function returns) must use
      // the returned resolved path, not their own lexical parent path.
      const targetStat = fsSync.statSync(nextReal);
      if (!targetStat.isDirectory()) {
        throw directoryComponentNotDirectoryError();
      }
      currentGuard = await createAsyncDirectoryGuard(nextReal);
      assertNoWindowsPathAlias(
        currentGuard.realPath,
        "filesystem",
        "canonical directory uses a Windows filesystem namespace alias",
      );
      await assertAsyncDirectoryGuard(parentGuard);
      current = nextReal;
      continue;
    }
    currentGuard = await createAsyncDirectoryGuard(next);
    assertNoWindowsPathAlias(
      currentGuard.realPath,
      "filesystem",
      "canonical directory uses a Windows filesystem namespace alias",
    );
    await assertAsyncDirectoryGuard(parentGuard);
    current = next;
  }
  return current;
}
