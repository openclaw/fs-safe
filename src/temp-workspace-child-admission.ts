import type { BigIntStats, Stats } from "node:fs";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { pinNodeDirectoryForMode, pinNodeDirectoryForModeSync } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import type { TempWorkspaceRootAdmission } from "./temp-workspace-admission.js";
import type { TempWorkspaceRetainedChild } from "./temp-workspace-descriptor.js";
import type { TempWorkspaceIdentityStat } from "./temp-workspace-identity.js";
import { assertTrustedTempWorkspaceDirectory } from "./temp-workspace-permissions.js";

const WINDOWS = process.platform === "win32";

function assertTempWorkspaceChildState(
  stat: BigIntStats | Stats,
  ownerUid: number | undefined,
): void {
  const exactIdentity = typeof stat.dev === "bigint" && typeof stat.ino === "bigint" &&
    (!WINDOWS || (stat.dev !== 0n && stat.ino !== 0n));
  const safeLinuxIdentity = process.platform === "linux" &&
    typeof stat.dev === "number" && Number.isSafeInteger(stat.dev) && stat.dev >= 0 &&
    typeof stat.ino === "number" && Number.isSafeInteger(stat.ino) && stat.ino >= 0;
  if (!exactIdentity && !safeLinuxIdentity) {
    throw new FsSafeError("path-mismatch", "temp workspace child identity could not be verified");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new FsSafeError("not-file", "temp workspace child must be a real directory");
  }
  assertTrustedTempWorkspaceDirectory(stat, ownerUid, true);
}

export function validateInitialTempWorkspaceChild(
  stat: BigIntStats,
  ownerUid: number | undefined,
): void {
  assertTempWorkspaceChildState(stat, ownerUid);
}

function childHasRequestedMode(stat: BigIntStats | Stats, mode: number): boolean {
  // Windows st_mode does not establish ACL privacy. Creation still validates
  // the exact named object, while the supplied root's ACL remains caller trust.
  return WINDOWS || (typeof stat.mode === "bigint"
    ? Number(stat.mode & 0o7777n)
    : stat.mode & 0o7777) === (mode & 0o7777);
}

function tempWorkspaceChildNeedsModeInitialization(
  expected: BigIntStats,
  ownerUid: number | undefined,
  mode: number,
): boolean {
  assertTempWorkspaceChildState(expected, ownerUid);
  return !childHasRequestedMode(expected, mode);
}

async function initializeTempWorkspaceChildMode(
  dir: string,
  expected: BigIntStats,
  parent: TempWorkspaceRootAdmission,
  mode: number,
): Promise<void> {
  parent.assertCurrent();
  const owner = await pinNodeDirectoryForMode(dir, {
    expectedIdentity: expected,
    ownerUid: parent.ownerUid,
  });
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
  dir: string,
  expected: BigIntStats,
  parent: TempWorkspaceRootAdmission,
  mode: number,
): Promise<void> | undefined {
  if (!tempWorkspaceChildNeedsModeInitialization(expected, parent.ownerUid, mode)) return undefined;
  return initializeTempWorkspaceChildMode(dir, expected, parent, mode);
}

export function admitTempWorkspaceChildSync(
  dir: string,
  expected: BigIntStats,
  parent: TempWorkspaceRootAdmission,
  mode: number,
): void {
  if (!tempWorkspaceChildNeedsModeInitialization(expected, parent.ownerUid, mode)) return;
  parent.assertCurrent();
  const owner = pinNodeDirectoryForModeSync(dir, {
    expectedIdentity: expected,
    ownerUid: parent.ownerUid,
  });
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
    hasRequestedMode: (stat: TempWorkspaceIdentityStat) => childHasRequestedMode(stat, mode),
    validate: (stat: TempWorkspaceIdentityStat) => assertTempWorkspaceChildState(stat, parent.ownerUid),
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
  current: TempWorkspaceIdentityStat,
  ownerUid: number | undefined,
  mode: number,
): TempWorkspaceIdentityStat {
  assertTempWorkspaceChildState(current, ownerUid);
  if (!childHasRequestedMode(current, mode)) {
    throw new FsSafeError("path-mismatch", "temp workspace final mode could not be verified");
  }
  return current;
}
