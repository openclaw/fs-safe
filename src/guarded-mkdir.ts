import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertAsyncDirectoryGuard,
  createAsyncDirectoryGuard,
  inspectDirectoryIdentitySync,
  type AsyncDirectoryGuard,
} from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError, isPathRelativeEscape } from "./path.js";
import { directoryComponentNotDirectoryError, rootPathChangedError } from "./root-errors.js";
import { realpathSync } from "./realpath.js";
import { admitPathInsideRoot, type RootBoundaryIdentity } from "./root-boundary.js";
import { checkedMutationDirectory, type MutationDirectoryObservation } from "./pinned-mutation-observation.js";
import type {
  PinnedCreatedDirectoryReceipt,
  PinnedMutationAdmissionReceipt,
  PinnedMutationAuthorizationToken,
} from "./pinned-write.js";
import {
  createPathSegmentRoute,
  joinPathSegmentRoute,
  type PathSegmentRoute,
} from "./path-segment-route.js";

function sameDirectoryFacts(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink;
}

function inspectGuardCurrent(parent: AsyncDirectoryGuard<BigIntStats>): BigIntStats {
  const stat = inspectDirectoryIdentitySync(parent.dir, parent.stat);
  if (realpathSync.native(parent.dir) !== parent.realPath) {
    throw new FsSafeError("path-mismatch", "directory changed during operation");
  }
  return stat;
}

function observedGuard(parent: AsyncDirectoryGuard<BigIntStats>): MutationDirectoryObservation {
  return checkedMutationDirectory(parent.dir, parent.realPath, parent.stat);
}

type CreatedDirectoryEvidence = Readonly<{
  receipt: PinnedCreatedDirectoryReceipt;
  guard: AsyncDirectoryGuard<BigIntStats>;
}>;

function createdDirectoryEvidence(
  admission: PinnedMutationAdmissionReceipt,
  parent: AsyncDirectoryGuard<BigIntStats>,
  childPath: string,
): CreatedDirectoryEvidence | undefined {
  try {
    const parentAfter = inspectGuardCurrent(parent);
    const childBefore = inspectDirectoryIdentitySync(childPath);
    const realPath = realpathSync.native(childPath);
    if (realPath !== childPath) return undefined;
    const childAfter = inspectDirectoryIdentitySync(childPath, childBefore);
    if (!sameDirectoryFacts(childBefore, childAfter)) return undefined;
    const child = checkedMutationDirectory(childPath, realPath, childAfter);
    const receipt = Object.freeze({
      admission,
      parent: checkedMutationDirectory(parent.dir, parent.realPath, parentAfter),
      child,
    });
    return Object.freeze({
      receipt,
      guard: Object.freeze({ dir: childPath, realPath, stat: childAfter }),
    });
  } catch {
    // Failed optional evidence leaves the existing ordered admission in charge.
    return undefined;
  }
}

function sameAbsolutePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

type ExactRootIdentity = Readonly<{ dev: bigint; ino: bigint }>;

function suppliedExactRootIdentity(identity: RootBoundaryIdentity | undefined): ExactRootIdentity | undefined {
  return typeof identity?.dev === "bigint" && typeof identity.ino === "bigint"
    ? { dev: identity.dev, ino: identity.ino }
    : undefined;
}

function assertGuardMatchesRootIdentity(
  guard: AsyncDirectoryGuard<BigIntStats>,
  expected: ExactRootIdentity,
): void {
  if (guard.stat.dev !== expected.dev || guard.stat.ino !== expected.ino) {
    throw rootPathChangedError();
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === "function";
}

async function realpathOrThrowNotFile(target: string): Promise<string> {
  try {
    return path.resolve(realpathSync.native(target));
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
  beforeCreateComponent?: (
    componentPath: string,
    prospectiveTargetPath: string,
    retainedTargetPath: string | undefined,
    parent: MutationDirectoryObservation,
  ) => Promise<PinnedMutationAdmissionReceipt | undefined> | PinnedMutationAdmissionReceipt | undefined;
  beforeUseComponent?: (
    componentPath: string,
    prospectiveTargetPath: string,
    retainedTargetPath: string | undefined,
  ) => Promise<void> | void;
  afterCreateComponent?: (
    receipt: PinnedCreatedDirectoryReceipt,
  ) => PinnedMutationAuthorizationToken | undefined;
  assertBeforeMutation?: () => void;
  mode?: number;
  rejectSymlinks?: boolean;
  revalidateParentAfterBeforeComponent?: boolean;
  synchronousAuthorizationIncludesFence?: boolean;
  retainedTargetPath?: string;
  rootIdentity?: RootBoundaryIdentity;
}): Promise<string> {
  const root = path.resolve(params.rootReal);
  const configuredRootGuard = await createAsyncDirectoryGuard(root, { bigint: true });
  const suppliedIdentity = suppliedExactRootIdentity(params.rootIdentity);
  const checkedRootIdentity = suppliedIdentity ?? {
    dev: configuredRootGuard.stat.dev,
    ino: configuredRootGuard.stat.ino,
  };
  assertGuardMatchesRootIdentity(configuredRootGuard, checkedRootIdentity);
  const rootCanonical = path.resolve(configuredRootGuard.realPath);
  const rootGuard = rootCanonical === root
    ? configuredRootGuard
    : await createAsyncDirectoryGuard(rootCanonical, { bigint: true });
  assertGuardMatchesRootIdentity(rootGuard, checkedRootIdentity);

  const target = path.resolve(params.targetPath);
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
  let currentGuard: AsyncDirectoryGuard<BigIntStats> = rootGuard;
  const parts = admittedTarget.relativePath.split(path.sep).filter(Boolean);
  let partRoute: PathSegmentRoute | undefined;
  let retainedTargetPath = params.retainedTargetPath &&
    sameAbsolutePath(path.dirname(params.retainedTargetPath), target)
    ? params.retainedTargetPath
    : undefined;
  let retainedParentPath = retainedTargetPath ? path.dirname(retainedTargetPath) : undefined;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    const next = path.join(current, part);
    const parentGuard = currentGuard;
    let created = false;
    let createReceipt: PinnedMutationAdmissionReceipt | undefined;
    if (!params.revalidateParentAfterBeforeComponent) {
      await assertAsyncDirectoryGuard(parentGuard);
    }
    await params.beforeComponent?.(next);
    if (params.revalidateParentAfterBeforeComponent) {
      await assertAsyncDirectoryGuard(parentGuard);
    }
    if (params.beforeCreateComponent) {
      let missing = false;
      try {
        fsSync.lstatSync(next);
      } catch (error) {
        if (!isNotFoundPathError(error)) throw error;
        missing = true;
      }
      if (missing) {
        let prospectiveParent = retainedParentPath;
        if (!prospectiveParent) {
          partRoute ??= createPathSegmentRoute(parts);
          prospectiveParent = joinPathSegmentRoute(next, partRoute, index + 1);
        }
        const authorization = params.beforeCreateComponent(
          next,
          prospectiveParent,
          retainedTargetPath,
          observedGuard(parentGuard),
        );
        if (isPromiseLike(authorization)) {
          createReceipt = await authorization;
          await assertAsyncDirectoryGuard(parentGuard);
        } else {
          createReceipt = authorization;
          // A synchronous authorization must still end at a live pathname
          // fence immediately before the authority callback and mkdir.
          if (!params.synchronousAuthorizationIncludesFence) inspectGuardCurrent(parentGuard);
        }
        params.assertBeforeMutation?.();
        // Authority callbacks are an explicit freshness boundary. Recheck the
        // exact parent synchronously so no callback-observed authority is
        // carried into a pathname mkdir after the parent was swapped.
        inspectGuardCurrent(parentGuard);
        try {
          await fs.mkdir(next, { mode: params.mode });
          created = true;
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
            throw error;
          }
        }
      }
    } else {
      params.assertBeforeMutation?.();
      try {
        await fs.mkdir(next, { mode: params.mode });
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
          throw error;
        }
      }
    }
    let createdAuthorization: PinnedMutationAuthorizationToken | undefined;
    let createdEvidence: CreatedDirectoryEvidence | undefined;
    if (created && createReceipt && params.afterCreateComponent) {
      createdEvidence = createdDirectoryEvidence(createReceipt, parentGuard, next);
      if (createdEvidence) {
        createdAuthorization = params.afterCreateComponent(createdEvidence.receipt);
      }
    }
    if (params.beforeUseComponent && !createdAuthorization) {
      let prospectiveParent = retainedParentPath;
      if (!prospectiveParent) {
        partRoute ??= createPathSegmentRoute(parts);
        prospectiveParent = joinPathSegmentRoute(next, partRoute, index + 1);
      }
      await params.beforeUseComponent(next, prospectiveParent, retainedTargetPath);
      await assertAsyncDirectoryGuard(parentGuard);
    }
    const stat = createdAuthorization ? undefined : fsSync.lstatSync(next);
    if (stat && ((params.rejectSymlinks && stat.isSymbolicLink()) ||
      (!stat.isSymbolicLink() && !stat.isDirectory()))) {
      throw directoryComponentNotDirectoryError();
    }
    // Node's recursive mkdir follows symlinks in missing components. Build one
    // segment at a time and realpath-check each segment before descending.
    const nextReal = createdAuthorization && createdEvidence
      ? createdEvidence.receipt.child.canonicalPath
      : await realpathOrThrowNotFile(next);
    const admittedNextReal = admitPathInsideRoot({
      rootPath: rootCanonical,
      candidatePath: nextReal,
      rootIdentity: checkedRootIdentity,
    });
    if (!admittedNextReal) {
      throw new FsSafeError("outside-workspace", "directory escaped workspace root");
    }
    const admittedNextPath = admittedNextReal.path;
    if (stat?.isSymbolicLink()) {
      // An existing path component may legitimately be a symlink to a real
      // directory inside the root (e.g. a skill-bank layout). We already
      // verified above that it resolves inside the root, so treat the
      // resolved real path as the directory for the rest of this walk
      // instead of rejecting it outright. Guard checks from here on operate
      // on the real (non-symlink) path, preserving TOCTOU protection for
      // every subsequent segment. Callers that need the final directory
      // (e.g. to guard it themselves after this function returns) must use
      // the returned resolved path, not their own lexical parent path.
      const targetStat = fsSync.statSync(admittedNextPath);
      if (!targetStat.isDirectory()) {
        throw directoryComponentNotDirectoryError();
      }
      currentGuard = await createAsyncDirectoryGuard(admittedNextPath, { bigint: true });
      await assertAsyncDirectoryGuard(parentGuard);
      retainedTargetPath = undefined;
      retainedParentPath = undefined;
      current = admittedNextPath;
      continue;
    }
    if (createdAuthorization && createdEvidence) {
      currentGuard = createdEvidence.guard;
    } else {
      currentGuard = await createAsyncDirectoryGuard(admittedNextPath, { bigint: true });
      await assertAsyncDirectoryGuard(parentGuard);
    }
    current = admittedNextPath;
  }
  return current;
}
