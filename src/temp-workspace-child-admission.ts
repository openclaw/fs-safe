import fsSync, { type BigIntStats, type Stats } from "node:fs";
import { inspectDirectoryIdentitySync, observeDirectoryIdentitySync } from "./directory-guard.js";
import { pinNodeDirectoryForMode, pinNodeDirectoryForModeSync } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import { fileIdentityMismatchError, inspectFileIdentitySync } from "./strict-file-identity.js";
import type { TempWorkspaceRootAdmission } from "./temp-workspace-admission.js";
import { classifyTempWorkspaceOwner, warnUnmappedTempWorkspaceAncestor } from "./temp-workspace-ownership.js";

export type TempWorkspaceIdentity = Readonly<{ dev: bigint; ino: bigint }>;
export type TempWorkspaceNumericIdentity = Readonly<{ dev: number; ino: number }>;
export type TempWorkspaceIdentityStat = BigIntStats | Stats;

export const TEMP_WORKSPACE_NUMERIC_IDENTITY_REPLAY =
  process.platform === "linux" || process.platform === "darwin";

export function projectTempWorkspaceNumericIdentity(
  identity: TempWorkspaceIdentity,
): TempWorkspaceNumericIdentity | undefined {
  const dev = Number(identity.dev);
  const ino = Number(identity.ino);
  if (
    !Number.isSafeInteger(dev) || dev < 0 || BigInt(dev) !== identity.dev ||
    !Number.isSafeInteger(ino) || ino < 0 || BigInt(ino) !== identity.ino
  ) {
    return undefined;
  }
  return Object.freeze({ dev, ino });
}

function inspectNumericIdentity(
  current: Stats,
  expected: TempWorkspaceNumericIdentity,
): Stats {
  if (
    !Number.isSafeInteger(current.dev) || current.dev < 0 || current.dev !== expected.dev ||
    !Number.isSafeInteger(current.ino) || current.ino < 0 || current.ino !== expected.ino
  ) {
    throw fileIdentityMismatchError();
  }
  return current;
}

export function inspectTempWorkspaceDescriptorIdentitySync(
  fd: number,
  expected: TempWorkspaceIdentity,
  numeric: TempWorkspaceNumericIdentity | undefined,
): TempWorkspaceIdentityStat {
  // A malformed or mismatched numeric observation is definite and never
  // retried. Unsafe receipts and other platforms retain exact replay.
  if (TEMP_WORKSPACE_NUMERIC_IDENTITY_REPLAY && numeric) {
    return inspectNumericIdentity(fsSync.fstatSync(fd), numeric);
  }
  return inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true }), expected);
}

export function inspectTempWorkspaceDirectoryIdentitySync(
  dir: string,
  expected: TempWorkspaceIdentity,
  numeric: TempWorkspaceNumericIdentity | undefined,
): TempWorkspaceIdentityStat {
  if (TEMP_WORKSPACE_NUMERIC_IDENTITY_REPLAY && numeric) {
    return inspectNumericIdentity(observeDirectoryIdentitySync(dir), numeric);
  }
  return inspectFileIdentitySync(
    () => observeDirectoryIdentitySync(dir, { bigint: true }),
    expected,
  );
}

export function validateTempWorkspaceDirMode(mode: number): void {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new FsSafeError("insecure-permissions", "temp workspace dirMode must be permission bits");
  }
  if (process.platform !== "win32" && (mode & 0o022) !== 0) {
    throw new FsSafeError("insecure-permissions", "temp workspace must not be group/world writable");
  }
}

export function assertTrustedTempWorkspaceDirectory(
  stat: Pick<BigIntStats, "uid" | "gid" | "mode"> | Pick<Stats, "uid" | "gid" | "mode">,
  uid: number | undefined,
  privateDirectory = false,
): void {
  if (uid === undefined) return;
  const ownership = classifyTempWorkspaceOwner(stat, uid);
  if (ownership === "foreign" || (privateDirectory && ownership !== "user")) {
    throw new FsSafeError("not-owned", "temp workspace directory has an untrusted owner; use a private temp root owned by the effective user under a trusted directory hierarchy");
  }
  // Unmapped ancestors do not prove host ownership. To support private user-namespace
  // workspaces, trust the host hierarchy against unmapped host peers; retain mode
  // checks and strict effective-user ownership for the supplied root and new child.
  const writable = typeof stat.mode === "bigint"
    ? (stat.mode & 0o022n) !== 0n
    : Number.isSafeInteger(stat.mode) && stat.mode >= 0 && (stat.mode & 0o022) !== 0;
  const sticky = typeof stat.mode === "bigint"
    ? (stat.mode & 0o1000n) !== 0n
    : Number.isSafeInteger(stat.mode) && stat.mode >= 0 && (stat.mode & 0o1000) !== 0;
  if (typeof stat.mode !== "bigint" && (!Number.isSafeInteger(stat.mode) || stat.mode < 0)) {
    throw new FsSafeError("insecure-permissions", "temp workspace directory permissions are invalid");
  }
  if (writable && (privateDirectory || !sticky)) {
    throw new FsSafeError(
      "insecure-permissions",
      privateDirectory
        ? "temp workspace root and child must not be group/world writable; use a private temp directory"
        : "temp workspace ancestor is group/world writable without sticky protection",
    );
  }
  if (ownership === "unmapped") warnUnmappedTempWorkspaceAncestor();
}

const WINDOWS = process.platform === "win32";

export function assertTempWorkspaceChildState(
  stat: BigIntStats | Stats,
  ownerUid: number | undefined,
): void {
  const exactIdentity = typeof stat.dev === "bigint" && typeof stat.ino === "bigint" &&
    (!WINDOWS || (stat.dev !== 0n && stat.ino !== 0n));
  const safeNumericIdentity = TEMP_WORKSPACE_NUMERIC_IDENTITY_REPLAY &&
    typeof stat.dev === "number" && Number.isSafeInteger(stat.dev) && stat.dev >= 0 &&
    typeof stat.ino === "number" && Number.isSafeInteger(stat.ino) && stat.ino >= 0;
  if (!exactIdentity && !safeNumericIdentity) {
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
  mode: number,
): boolean {
  assertTempWorkspaceChildState(stat, ownerUid);
  return !childHasRequestedMode(stat, mode);
}

export function childHasRequestedMode(stat: BigIntStats | Stats, mode: number): boolean {
  // Windows st_mode does not establish ACL privacy. Creation still validates
  // the exact named object, while the supplied root's ACL remains caller trust.
  return WINDOWS || (typeof stat.mode === "bigint"
    ? Number(stat.mode & 0o7777n)
    : stat.mode & 0o7777) === (mode & 0o7777);
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
  if (!validateInitialTempWorkspaceChild(expected, parent.ownerUid, mode)) return undefined;
  return initializeTempWorkspaceChildMode(dir, expected, parent, mode);
}

export function admitTempWorkspaceChildSync(
  dir: string,
  expected: BigIntStats,
  parent: TempWorkspaceRootAdmission,
  mode: number,
): void {
  if (!validateInitialTempWorkspaceChild(expected, parent.ownerUid, mode)) return;
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
