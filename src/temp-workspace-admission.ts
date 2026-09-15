import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { pinNodeDirectoryForMode, pinNodeDirectoryForModeSync } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import { realpathSync } from "./realpath.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

type DirectorySnapshot = { dir: string; realPath: string; stat: BigIntStats };
export type TempWorkspaceRootAssociation = Readonly<{
  dir: string;
  realPath: string;
  stat: BigIntStats;
}>;
export type TempWorkspaceRootAdmission = {
  dir: string;
  ownerUid: number | undefined;
  assertCurrent(): void;
  assertAncestry(): void;
  associateCurrent(inspectDescriptor: () => BigIntStats): TempWorkspaceRootAssociation;
  associateAncestry(inspectDescriptor: () => BigIntStats): TempWorkspaceRootAssociation;
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
  if (process.platform === "win32") return undefined;
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

function assertTrustedDirectory(stat: BigIntStats, uid: number | undefined, child = false): void {
  if (uid === undefined) return;
  if (stat.uid !== BigInt(uid) && (child || stat.uid !== 0n)) {
    throw new FsSafeError("not-owned", "temp workspace directory has an untrusted owner");
  }
  // A root/current-user-owned sticky directory protects children owned by us,
  // including the usual shared system temp directory. Never chmod that parent.
  if ((stat.mode & 0o022n) !== 0n && (child || (stat.mode & 0o1000n) === 0n)) {
    throw new FsSafeError("insecure-permissions", "temp workspace directory is group/world writable without sticky protection");
  }
}

function snapshot(dir: string, uid: number | undefined, realPath = realpathSync.native(dir)): DirectorySnapshot {
  const stat = inspectDirectoryIdentitySync(dir);
  assertTrustedDirectory(stat, uid);
  return { dir, realPath, stat };
}

function assertCanonicalRoot(entry: DirectorySnapshot): void {
  if (realpathSync.native(entry.dir) !== entry.realPath) {
    throw new FsSafeError("path-mismatch", "temp workspace root ancestry changed");
  }
}

function inspectSnapshot(entry: DirectorySnapshot, uid: number | undefined): BigIntStats {
  const stat = inspectDirectoryIdentitySync(entry.dir, entry.stat);
  assertTrustedDirectory(stat, uid);
  assertCanonicalRoot(entry);
  return stat;
}

function inspectChain(
  chain: DirectorySnapshot[], uid: number | undefined,
): { entry: DirectorySnapshot; stat: BigIntStats } {
  let current: BigIntStats | undefined;
  for (const entry of chain) {
    current = inspectDirectoryIdentitySync(entry.dir, entry.stat);
    assertTrustedDirectory(current, uid);
  }
  const last = chain[chain.length - 1]!;
  assertCanonicalRoot(last);
  return { entry: last, stat: current! };
}

function associateTempWorkspaceRoot(
  entry: DirectorySnapshot,
  named: BigIntStats,
  ownerUid: number | undefined,
  inspectDescriptor: () => BigIntStats,
): TempWorkspaceRootAssociation {
  const stat = inspectFileIdentitySync(inspectDescriptor, named);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new FsSafeError("not-file", "temp workspace cleanup parent must be a real directory");
  }
  assertTrustedDirectory(stat, ownerUid);
  return Object.freeze({ stat, dir: entry.dir, realPath: entry.realPath });
}

function rootPlan(rootDir: string): {
  chain: DirectorySnapshot[];
  missing: string[];
  ownerUid: number | undefined;
} {
  const ownerUid = effectiveOwner();
  let ancestor = path.resolve(rootDir);
  const missing: string[] = [];
  for (;;) {
    try {
      fsSync.lstatSync(ancestor);
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
  ancestor = realpathSync.native(ancestor);
  const ancestry: string[] = [];
  for (let current = ancestor;; current = path.dirname(current)) {
    ancestry.push(current);
    if (path.dirname(current) === current) break;
  }
  const chain = ancestry.reverse().map((dir) => snapshot(dir, ownerUid, dir));
  // Missing-component creation needs a replay before its first mutation. When
  // the complete root already exists, the caller's pre-mkdtemp ancestry pass
  // is the first mutation boundary and makes an immediate replay redundant.
  if (missing.length > 0) inspectChain(chain, ownerUid);
  return { chain, missing, ownerUid };
}

function rootAdmission(chain: DirectorySnapshot[], ownerUid: number | undefined): TempWorkspaceRootAdmission {
  // Bind the immediate parent now: missing-component creation appends to chain.
  const current = chain[chain.length - 1]!;
  return {
    dir: current.dir,
    ownerUid,
    assertCurrent: () => { inspectSnapshot(current, ownerUid); },
    assertAncestry: () => { inspectChain(chain, ownerUid); },
    associateCurrent: (inspectDescriptor) => associateTempWorkspaceRoot(
      current,
      inspectSnapshot(current, ownerUid),
      ownerUid,
      inspectDescriptor,
    ),
    associateAncestry: (inspectDescriptor) => {
      const observed = inspectChain(chain, ownerUid);
      return associateTempWorkspaceRoot(
        observed.entry,
        observed.stat,
        ownerUid,
        inspectDescriptor,
      );
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
    const entry = snapshot(dir, ownerUid);
    if (created) {
      const modeInitialization = admitTempWorkspaceChild(dir, entry.stat, parent, 0o700);
      if (modeInitialization) await modeInitialization;
    }
    chain.push(entry);
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
    const entry = snapshot(dir, ownerUid);
    if (created) admitTempWorkspaceChildSync(dir, entry.stat, parent, 0o700);
    chain.push(entry);
  }
  return rootAdmission(chain, ownerUid);
}

function assertTempWorkspaceChildState(
  stat: BigIntStats, ownerUid: number | undefined,
): void {
  if (typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint" ||
    (process.platform === "win32" && (stat.dev === 0n || stat.ino === 0n))) {
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
  return process.platform === "win32" || Number(stat.mode & 0o7777n) === (mode & 0o7777);
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

export function inspectAdmittedTempWorkspaceChild(
  dir: string, expected: BigIntStats, ownerUid: number | undefined, mode: number,
): BigIntStats {
  const current = inspectDirectoryIdentitySync(dir, expected);
  return validateAdmittedTempWorkspaceChild(current, ownerUid, mode);
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
