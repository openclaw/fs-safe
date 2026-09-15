import fsSync, { type BigIntStats, type Stats } from "node:fs";
import { observeDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { recordFileObservationFailure } from "./file-observation.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

export type TempWorkspaceIdentity = Readonly<{ dev: bigint; ino: bigint }>;
export type TempWorkspaceNumericIdentity = Readonly<{ dev: number; ino: number }>;
export type TempWorkspaceIdentityStat = BigIntStats | Stats;

const LINUX = process.platform === "linux";

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

function identityMismatch(): never {
  const error = new FsSafeError("path-mismatch", "file identity changed or could not be verified");
  recordFileObservationFailure(error, "identity");
  throw error;
}

function inspectNumericIdentity(
  current: Stats,
  expected: TempWorkspaceNumericIdentity,
): Stats {
  if (
    !Number.isSafeInteger(current.dev) || current.dev < 0 || current.dev !== expected.dev ||
    !Number.isSafeInteger(current.ino) || current.ino < 0 || current.ino !== expected.ino
  ) {
    identityMismatch();
  }
  return current;
}

export function inspectTempWorkspaceDescriptorIdentitySync(
  fd: number,
  expected: TempWorkspaceIdentity,
  numeric: TempWorkspaceNumericIdentity | undefined,
): TempWorkspaceIdentityStat {
  // A malformed or mismatched numeric observation is definite and never
  // retried. Unsafe receipts and non-Linux platforms retain exact replay.
  if (LINUX && numeric) return inspectNumericIdentity(fsSync.fstatSync(fd), numeric);
  return inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true }), expected);
}

export function inspectTempWorkspaceDirectoryIdentitySync(
  dir: string,
  expected: TempWorkspaceIdentity,
  numeric: TempWorkspaceNumericIdentity | undefined,
): TempWorkspaceIdentityStat {
  if (LINUX && numeric) return inspectNumericIdentity(observeDirectoryIdentitySync(dir), numeric);
  return inspectFileIdentitySync(
    () => observeDirectoryIdentitySync(dir, { bigint: true }),
    expected,
  );
}
