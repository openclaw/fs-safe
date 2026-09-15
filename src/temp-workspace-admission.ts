import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  inspectDirectoryIdentitySync,
  observeDirectoryIdentitySync,
} from "./directory-guard.js";
import { pinNodeDirectoryForMode, pinNodeDirectoryForModeSync } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import { recordFileObservationFailure } from "./file-observation.js";
import { realpathSync } from "./realpath.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import type { TempWorkspaceRetainedChild } from "./temp-workspace-descriptor.js";

const WINDOWS = process.platform === "win32";

type ExactIdentity = Readonly<{ dev: bigint; ino: bigint }>;
type NumericIdentity = Readonly<{ dev: number; ino: number }>;
type ExactDirectoryObservation = Readonly<{
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  directory: boolean;
  symbolicLink: boolean;
}>;
type DirectorySnapshot = {
  dir: string;
  identity: ExactIdentity;
  numericIdentity: NumericIdentity | undefined;
  realPath: string;
};
type InspectedDirectorySnapshot = { entry: DirectorySnapshot; stat: BigIntStats };
export type TempWorkspaceRootAdmission = {
  dir: string;
  identity: ExactIdentity;
  ownerUid: number | undefined;
  realPath: string;
  assertCurrent(): void;
  assertAncestry(): void;
  associateCurrent(inspectDescriptor: () => BigIntStats): void;
  associateAncestry(inspectDescriptor: () => BigIntStats): void;
};

export function validateTempWorkspaceDirMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new FsSafeError("insecure-permissions", "temp workspace dirMode must be permission bits");
  }
  if (process.platform !== "win32" && (mode & 0o022) !== 0) {
    throw new FsSafeError("insecure-permissions", "temp workspace must not be group/world writable");
  }
}

function effectiveOwner(): number | undefined {
  // Windows mode/uid fields do not describe ACL authority. The supplied root's
  // ACL remains a caller trust requirement, independently of cleanup safety.
  if (WINDOWS) return undefined;
  let uid: number | undefined;
  try {
    uid = process.geteuid?.();
  } catch (cause) {
    throw new FsSafeError("permission-unverified", "temp workspace requires effective owner identity", { cause });
  }
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
    throw new FsSafeError("permission-unverified", "temp workspace requires effective owner identity");
  }
  return uid;
}

function assertTrustedDirectory(
  stat: Pick<BigIntStats, "uid" | "mode"> | Pick<Stats, "uid" | "mode">,
  uid: number | undefined,
  child = false,
): void {
  if (uid === undefined) return;
  const ownedByUser = typeof stat.uid === "bigint" ? stat.uid === BigInt(uid) : stat.uid === uid;
  const ownedByRoot = typeof stat.uid === "bigint" ? stat.uid === 0n : stat.uid === 0;
  if (!ownedByUser && (child || !ownedByRoot)) {
    throw new FsSafeError("not-owned", "temp workspace directory has an untrusted owner");
  }
  // A root/current-user-owned sticky directory protects children owned by us,
  // including the usual shared system temp directory. Never chmod that parent.
  const writable = typeof stat.mode === "bigint"
    ? (stat.mode & 0o022n) !== 0n
    : Number.isSafeInteger(stat.mode) && stat.mode >= 0 && (stat.mode & 0o022) !== 0;
  const sticky = typeof stat.mode === "bigint"
    ? (stat.mode & 0o1000n) !== 0n
    : Number.isSafeInteger(stat.mode) && stat.mode >= 0 && (stat.mode & 0o1000) !== 0;
  if (typeof stat.mode !== "bigint" && (!Number.isSafeInteger(stat.mode) || stat.mode < 0)) {
    throw new FsSafeError("insecure-permissions", "temp workspace directory permissions are invalid");
  }
  if (writable && (child || !sticky)) {
    throw new FsSafeError("insecure-permissions", "temp workspace directory is group/world writable without sticky protection");
  }
}

function safeNumericIdentity(stat: Pick<BigIntStats, "dev" | "ino">): NumericIdentity | undefined {
  const dev = Number(stat.dev);
  const ino = Number(stat.ino);
  if (
    !Number.isSafeInteger(dev) || dev < 0 || BigInt(dev) !== stat.dev ||
    !Number.isSafeInteger(ino) || ino < 0 || BigInt(ino) !== stat.ino ||
    (WINDOWS && (dev === 0 || ino === 0))
  ) {
    return undefined;
  }
  return Object.freeze({ dev, ino });
}

function copyExactDirectoryObservation(stat: BigIntStats): ExactDirectoryObservation {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode,
    directory: stat.isDirectory(),
    symbolicLink: stat.isSymbolicLink(),
  });
}

function snapshotFromExactObservation(
  dir: string,
  uid: number | undefined,
  realPath: string,
  stat: ExactDirectoryObservation,
): DirectorySnapshot {
  if (stat.symbolicLink || !stat.directory) {
    throw new FsSafeError("not-file", "temp workspace root component must be a real directory");
  }
  assertTrustedDirectory(stat, uid);
  const identity = Object.freeze({ dev: stat.dev, ino: stat.ino });
  // Retain copied immutable scalars, never a mutable Stats object supplied by
  // an observation hook. Every later permission check uses a fresh snapshot.
  return Object.freeze({ dir, identity, numericIdentity: safeNumericIdentity(stat), realPath });
}

function snapshot(
  dir: string,
  uid: number | undefined,
  realPath = realpathSync.native(dir),
): InspectedDirectorySnapshot {
  const stat = inspectDirectoryIdentitySync(dir);
  const observation = copyExactDirectoryObservation(stat);
  return { entry: snapshotFromExactObservation(dir, uid, realPath, observation), stat };
}

function hasCompleteExactIdentity(stat: ExactDirectoryObservation): boolean {
  return typeof stat.dev === "bigint" && typeof stat.ino === "bigint" &&
    (!WINDOWS || (stat.dev !== 0n && stat.ino !== 0n));
}

function assertCanonicalRoot(entry: DirectorySnapshot): void {
  if (realpathSync.native(entry.dir) !== entry.realPath) {
    throw new FsSafeError("path-mismatch", "temp workspace root ancestry changed");
  }
}

function identityMismatch(): never {
  const error = new FsSafeError("path-mismatch", "file identity changed or could not be verified");
  recordFileObservationFailure(error, "identity");
  throw error;
}

function inspectSnapshotIdentity(entry: DirectorySnapshot): BigIntStats | Stats {
  const expected = entry.numericIdentity;
  if (!expected) {
    return inspectDirectoryIdentitySync(entry.dir, entry.identity);
  }
  const stat = observeDirectoryIdentitySync(entry.dir);
  let requiresExactRetry = false;
  const devKnown = Number.isSafeInteger(stat.dev) && stat.dev >= 0 && (!WINDOWS || stat.dev !== 0);
  if (devKnown) {
    if (stat.dev !== expected.dev) identityMismatch();
  } else if (WINDOWS) requiresExactRetry = true;
  else identityMismatch();
  const inoKnown = Number.isSafeInteger(stat.ino) && stat.ino >= 0 && (!WINDOWS || stat.ino !== 0);
  if (inoKnown) {
    if (stat.ino !== expected.ino) identityMismatch();
  } else if (WINDOWS) requiresExactRetry = true;
  else identityMismatch();
  if (!requiresExactRetry) return stat;
  // Read exact identity only once. The strict helper may re-check this constant
  // receipt in memory when Windows still reports an unknown component.
  const exact = observeDirectoryIdentitySync(entry.dir, { bigint: true });
  return inspectFileIdentitySync(() => exact, entry.identity);
}

function assertSnapshot(entry: DirectorySnapshot, uid: number | undefined): void {
  const stat = inspectSnapshotIdentity(entry);
  assertTrustedDirectory(stat, uid);
  assertCanonicalRoot(entry);
}

function assertChain(chain: DirectorySnapshot[], uid: number | undefined): void {
  for (const entry of chain) {
    const current = inspectSnapshotIdentity(entry);
    assertTrustedDirectory(current, uid);
  }
  const last = chain[chain.length - 1]!;
  assertCanonicalRoot(last);
}

function associateTempWorkspaceRoot(
  entry: DirectorySnapshot,
  ownerUid: number | undefined,
  inspectDescriptor: () => BigIntStats,
): void {
  const stat = inspectFileIdentitySync(inspectDescriptor, entry.identity);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new FsSafeError("not-file", "temp workspace cleanup parent must be a real directory");
  }
  assertTrustedDirectory(stat, ownerUid);
}

function rootPlan(rootDir: string): {
  chain: DirectorySnapshot[];
  missing: string[];
  ownerUid: number | undefined;
} {
  const ownerUid = effectiveOwner();
  let ancestor = path.resolve(rootDir);
  const missing: string[] = [];
  let initial: ExactDirectoryObservation;
  for (;;) {
    try {
      initial = copyExactDirectoryObservation(fsSync.lstatSync(ancestor, { bigint: true }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
  missing.reverse();
  // Keep the historical support for a caller-approved root alias and standard
  // system aliases such as macOS /var. A dangling alias fails canonicalization.
  const observedAncestor = ancestor;
  ancestor = realpathSync.native(observedAncestor);
  const reuseInitialRoot = missing.length === 0 && observedAncestor === ancestor &&
    !initial.symbolicLink && initial.directory && hasCompleteExactIdentity(initial);
  const ancestry: string[] = [];
  for (let current = ancestor;; current = path.dirname(current)) {
    ancestry.push(current);
    if (path.dirname(current) === current) break;
  }
  const orderedAncestry = ancestry.reverse();
  const chain = orderedAncestry.map((dir, index) => {
    if (reuseInitialRoot && index === orderedAncestry.length - 1) {
      return snapshotFromExactObservation(dir, ownerUid, dir, initial);
    }
    return snapshot(dir, ownerUid, dir).entry;
  });
  // Missing-component creation needs a replay before its first mutation. When
  // the complete root already exists, the caller's pre-mkdtemp ancestry pass
  // is the first mutation boundary and makes an immediate replay redundant.
  if (missing.length > 0) assertChain(chain, ownerUid);
  return { chain, missing, ownerUid };
}

function rootAdmission(chain: DirectorySnapshot[], ownerUid: number | undefined): TempWorkspaceRootAdmission {
  // Bind the immediate parent now: missing-component creation appends to chain.
  const current = chain[chain.length - 1]!;
  return {
    dir: current.dir,
    identity: current.identity,
    ownerUid,
    realPath: current.realPath,
    assertCurrent: () => { assertSnapshot(current, ownerUid); },
    assertAncestry: () => { assertChain(chain, ownerUid); },
    associateCurrent: (inspectDescriptor) => {
      assertSnapshot(current, ownerUid);
      associateTempWorkspaceRoot(current, ownerUid, inspectDescriptor);
    },
    associateAncestry: (inspectDescriptor) => {
      assertChain(chain, ownerUid);
      associateTempWorkspaceRoot(current, ownerUid, inspectDescriptor);
    },
  };
}

export async function admitTempWorkspaceRoot(rootDir: string): Promise<TempWorkspaceRootAdmission> {
  const { chain, missing, ownerUid } = rootPlan(rootDir);
  for (const segment of missing) {
    const parent = rootAdmission(chain, ownerUid);
    const dir = path.join(parent.dir, segment);
    parent.assertCurrent();
    let created = false;
    try {
      await fs.mkdir(dir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    parent.assertCurrent();
    const observed = snapshot(dir, ownerUid);
    if (created) {
      const modeInitialization = admitTempWorkspaceChild(dir, observed.stat, parent, 0o700);
      if (modeInitialization) await modeInitialization;
    }
    chain.push(observed.entry);
  }
  return rootAdmission(chain, ownerUid);
}

export function admitTempWorkspaceRootSync(rootDir: string): TempWorkspaceRootAdmission {
  const { chain, missing, ownerUid } = rootPlan(rootDir);
  for (const segment of missing) {
    const parent = rootAdmission(chain, ownerUid);
    const dir = path.join(parent.dir, segment);
    parent.assertCurrent();
    let created = false;
    try {
      fsSync.mkdirSync(dir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    parent.assertCurrent();
    const observed = snapshot(dir, ownerUid);
    if (created) admitTempWorkspaceChildSync(dir, observed.stat, parent, 0o700);
    chain.push(observed.entry);
  }
  return rootAdmission(chain, ownerUid);
}

function assertTempWorkspaceChildState(
  stat: BigIntStats, ownerUid: number | undefined,
): void {
  if (typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint" ||
    (WINDOWS && (stat.dev === 0n || stat.ino === 0n))) {
    throw new FsSafeError("path-mismatch", "temp workspace child identity could not be verified");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new FsSafeError("not-file", "temp workspace child must be a real directory");
  }
  assertTrustedDirectory(stat, ownerUid, true);
}

export function validateInitialTempWorkspaceChild(
  stat: BigIntStats, ownerUid: number | undefined,
): void {
  assertTempWorkspaceChildState(stat, ownerUid);
}

function childHasRequestedMode(stat: BigIntStats, mode: number): boolean {
  // Windows st_mode does not establish ACL privacy. Creation still validates
  // the exact named object, while the supplied root's ACL remains caller trust.
  return WINDOWS || Number(stat.mode & 0o7777n) === (mode & 0o7777);
}

function tempWorkspaceChildNeedsModeInitialization(
  expected: BigIntStats, ownerUid: number | undefined, mode: number,
): boolean {
  assertTempWorkspaceChildState(expected, ownerUid);
  return !childHasRequestedMode(expected, mode);
}

async function initializeTempWorkspaceChildMode(
  dir: string, expected: BigIntStats, parent: TempWorkspaceRootAdmission, mode: number,
): Promise<void> {
  parent.assertCurrent();
  const owner = await pinNodeDirectoryForMode(dir, { expectedIdentity: expected, ownerUid: parent.ownerUid });
  try {
    await owner.apply(mode, { check: parent.assertCurrent });
    const current = inspectDirectoryIdentitySync(dir, expected);
    assertTempWorkspaceChildState(current, parent.ownerUid);
    if (!childHasRequestedMode(current, mode)) {
      throw new FsSafeError("path-mismatch", "temp workspace final mode could not be verified");
    }
    parent.assertCurrent();
  } finally {
    await owner.close();
  }
}

export function admitTempWorkspaceChild(
  dir: string, expected: BigIntStats, parent: TempWorkspaceRootAdmission, mode: number,
): Promise<void> | undefined {
  if (!tempWorkspaceChildNeedsModeInitialization(expected, parent.ownerUid, mode)) return undefined;
  return initializeTempWorkspaceChildMode(dir, expected, parent, mode);
}

export function admitTempWorkspaceChildSync(
  dir: string, expected: BigIntStats, parent: TempWorkspaceRootAdmission, mode: number,
): void {
  if (!tempWorkspaceChildNeedsModeInitialization(expected, parent.ownerUid, mode)) return;
  parent.assertCurrent();
  const owner = pinNodeDirectoryForModeSync(dir, { expectedIdentity: expected, ownerUid: parent.ownerUid });
  try {
    owner.apply(mode, parent.assertCurrent);
    const current = inspectDirectoryIdentitySync(dir, expected);
    assertTempWorkspaceChildState(current, parent.ownerUid);
    if (!childHasRequestedMode(current, mode)) {
      throw new FsSafeError("path-mismatch", "temp workspace final mode could not be verified");
    }
    parent.assertCurrent();
  } finally {
    owner.close();
  }
}

function retainedModeChecks(parent: TempWorkspaceRootAdmission, mode: number) {
  return {
    assertParent: parent.assertCurrent,
    hasRequestedMode: (stat: BigIntStats) => childHasRequestedMode(stat, mode),
    validate: (stat: BigIntStats) => assertTempWorkspaceChildState(stat, parent.ownerUid),
  };
}

export function admitRetainedTempWorkspaceChild(
  retained: TempWorkspaceRetainedChild,
  expected: BigIntStats,
  parent: TempWorkspaceRootAdmission,
  mode: number,
): Promise<void> | undefined {
  if (!tempWorkspaceChildNeedsModeInitialization(expected, parent.ownerUid, mode)) return undefined;
  return retained.initializeMode(mode, retainedModeChecks(parent, mode));
}

export function admitRetainedTempWorkspaceChildSync(
  retained: TempWorkspaceRetainedChild,
  expected: BigIntStats,
  parent: TempWorkspaceRootAdmission,
  mode: number,
): void {
  if (!tempWorkspaceChildNeedsModeInitialization(expected, parent.ownerUid, mode)) return;
  retained.initializeModeSync(mode, retainedModeChecks(parent, mode));
}

export function validateAdmittedTempWorkspaceChild(
  current: BigIntStats, ownerUid: number | undefined, mode: number,
): BigIntStats {
  assertTempWorkspaceChildState(current, ownerUid);
  if (!childHasRequestedMode(current, mode)) {
    throw new FsSafeError("path-mismatch", "temp workspace final mode could not be verified");
  }
  return current;
}
