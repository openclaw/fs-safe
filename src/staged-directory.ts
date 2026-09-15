import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import type { DirectoryReceipt } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import {
  checkedMutationDirectory,
  type MutationDirectoryObservation,
} from "./pinned-mutation-observation.js";
import { realpathSync } from "./realpath.js";
import type { StagedFileReceipt } from "./staged-file-types.js";

export type StagedDirectorySnapshot = StagedFileReceipt["directory"];

export type PolicyStagedDirectory = Readonly<{
  directory: StagedDirectorySnapshot;
  observation: MutationDirectoryObservation;
  stat: BigIntStats;
}>;

export function exactIdentityMatches(
  expected: FileIdentityStat,
  actual: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  return (["dev", "ino"] as const).every((key) => {
    const value = expected[key];
    return (typeof value === "bigint" || Number.isSafeInteger(value)) && BigInt(value) === actual[key];
  });
}

export function describeStagedDirectory(fd: number, pathname: string): StagedDirectorySnapshot {
  const identity = fs.fstatSync(fd, { bigint: true });
  if (!identity.isDirectory()) {
    throw new FsSafeError("not-file", "staging parent must be a directory");
  }
  const receipt = Object.freeze({
    path: path.resolve(pathname),
    realPath: realpathSync(pathname),
    identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
  });
  assertStagedDirectoryCurrent(receipt);
  return receipt;
}

export function assertStagedDirectoryCurrent(receipt: StagedDirectorySnapshot): BigIntStats {
  const current = fs.lstatSync(receipt.path, { bigint: true });
  if (
    !current.isDirectory() || !exactIdentityMatches(receipt.identity, current) ||
    realpathSync(receipt.path) !== receipt.realPath
  ) {
    throw new FsSafeError("path-mismatch", "staging directory pathname changed");
  }
  return current;
}

function sameDirectoryMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink;
}

// The policy hot path is Node/POSIX-only. It deliberately uses native
// canonicalization so a successful capture contains no JS realpath work.
export function describePolicyStagedDirectory(
  fd: number,
  pathname: string,
): PolicyStagedDirectory {
  const resolved = path.resolve(pathname);
  const descriptor = fs.fstatSync(fd, { bigint: true });
  if (!descriptor.isDirectory()) {
    throw new FsSafeError("not-file", "staging parent must be a directory");
  }
  const before = inspectDirectoryIdentitySync(resolved);
  const canonicalPath = path.resolve(realpathSync.native(resolved));
  const after = inspectDirectoryIdentitySync(resolved, descriptor);
  if (canonicalPath !== resolved || !sameDirectoryMetadata(descriptor, before) ||
    !sameDirectoryMetadata(descriptor, after) ||
    path.resolve(realpathSync.native(resolved)) !== canonicalPath) {
    throw new FsSafeError("path-mismatch", "staging directory pathname changed");
  }
  const directory = Object.freeze({
    path: resolved,
    realPath: canonicalPath,
    identity: Object.freeze({ dev: descriptor.dev, ino: descriptor.ino }),
  });
  return Object.freeze({
    directory,
    observation: checkedMutationDirectory(resolved, canonicalPath, after),
    stat: after,
  });
}

export function assertPolicyStagedDirectoryCurrent(
  captured: PolicyStagedDirectory,
): BigIntStats {
  const current = inspectDirectoryIdentitySync(captured.directory.path, captured.directory.identity);
  if (!sameDirectoryMetadata(captured.stat, current) ||
    path.resolve(realpathSync.native(captured.directory.path)) !== captured.directory.realPath) {
    throw new FsSafeError("path-mismatch", "staging directory pathname changed");
  }
  return current;
}

export function refreshPolicyStagedDirectoryObservation(
  captured: PolicyStagedDirectory,
): MutationDirectoryObservation {
  const current = inspectDirectoryIdentitySync(
    captured.directory.path,
    captured.directory.identity,
  );
  const canonicalPath = path.resolve(realpathSync.native(captured.directory.path));
  if (canonicalPath !== captured.directory.realPath) {
    throw new FsSafeError("path-mismatch", "staging directory pathname changed");
  }
  return checkedMutationDirectory(captured.directory.path, canonicalPath, current);
}

export function openStagedDirectory(directory: string | DirectoryReceipt): {
  fd: number;
  receipt: StagedDirectorySnapshot;
} {
  // Copy supplied facts before any asynchronous work; receipts are not authority.
  const pathname = path.resolve(typeof directory === "string" ? directory : directory.path);
  const expected = typeof directory === "string" ? undefined : {
    realPath: directory.realPath, dev: directory.identity.dev, ino: directory.identity.ino,
  };
  const before = fs.lstatSync(pathname, { bigint: true });
  if (!before.isDirectory()) {
    throw new FsSafeError("not-file", "staging parent must be a real directory");
  }
  if (expected && (!exactIdentityMatches(expected, before) || realpathSync(pathname) !== expected.realPath)) {
    throw new FsSafeError("path-mismatch", "stale staging directory receipt");
  }
  const fd = fs.openSync(
    pathname,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const receipt = describeStagedDirectory(fd, pathname);
    if (!exactIdentityMatches(before, receipt.identity)) {
      throw new FsSafeError("path-mismatch", "staging directory changed while opening");
    }
    return { fd, receipt };
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch (closeError) {
      throw new AggregateError([error, closeError], "staging directory admission and close failed");
    }
    throw error;
  }
}
