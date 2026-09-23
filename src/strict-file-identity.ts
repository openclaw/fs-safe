import type { BigIntStats } from "node:fs";
import { FsSafeError } from "./errors.js";
import { recordFileObservationFailure } from "./file-observation.js";

type ExactFileIdentity = Pick<BigIntStats, "dev" | "ino">;

export function fileIdentityMismatchError(): FsSafeError {
  const error = new FsSafeError("path-mismatch", "file identity changed or could not be verified");
  recordFileObservationFailure(error, "identity");
  return error;
}

function identityCheck(expected: ExactFileIdentity | undefined, platform: NodeJS.Platform) {
  const known: Partial<ExactFileIdentity> = {};
  const check = (stat: ExactFileIdentity): boolean => {
    let complete = true;
    for (const field of ["dev", "ino"] as const) {
      const value = stat[field];
      // Numeric receipts cannot recover identity bits already lost to rounding.
      if (typeof value !== "bigint") throw fileIdentityMismatchError();
      if (platform === "win32" && value === 0n) {
        complete = false;
      } else {
        if (known[field] !== undefined && known[field] !== value) throw fileIdentityMismatchError();
        known[field] = value;
      }
    }
    return complete;
  };
  if (expected && !check(expected)) throw fileIdentityMismatchError();
  return check;
}

// Retry only unknown Windows identities, retaining every known component so a
// later observation cannot erase a definite mismatch. Never reopen the file.
export async function inspectFileIdentity<T extends ExactFileIdentity>(
  inspect: () => T | Promise<T>,
  expected?: ExactFileIdentity,
  platform: NodeJS.Platform = process.platform,
): Promise<T> {
  const check = identityCheck(expected, platform);
  for (let attempt = 0; attempt < 2; attempt++) {
    const stat = await inspect();
    if (check(stat)) return stat;
  }
  throw fileIdentityMismatchError();
}

export function inspectFileIdentitySync<T extends ExactFileIdentity>(
  inspect: () => T,
  expected?: ExactFileIdentity,
  platform: NodeJS.Platform = process.platform,
  mismatch: () => Error = fileIdentityMismatchError,
): T {
  let knownDev: bigint | undefined;
  let knownIno: bigint | undefined;
  if (expected) {
    knownDev = expected.dev;
    if (typeof knownDev !== "bigint") throw mismatch();
    knownIno = expected.ino;
    if (typeof knownIno !== "bigint") throw mismatch();
    // An unknown expected device must not bypass observation of its inode.
    if (platform === "win32" && (knownDev === 0n || knownIno === 0n)) throw mismatch();
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const stat = inspect();
    let complete = true;
    // Keep dev-before-ino access and early mismatch errors without allocating
    // a checker closure, known-component object, or field array per inspection.
    const dev = stat.dev;
    if (typeof dev !== "bigint") throw mismatch();
    if (platform === "win32" && dev === 0n) {
      complete = false;
    } else {
      if (knownDev !== undefined && knownDev !== dev) throw mismatch();
      knownDev = dev;
    }
    const ino = stat.ino;
    if (typeof ino !== "bigint") throw mismatch();
    if (platform === "win32" && ino === 0n) {
      complete = false;
    } else {
      if (knownIno !== undefined && knownIno !== ino) throw mismatch();
      knownIno = ino;
    }
    if (complete) return stat;
  }
  throw mismatch();
}
