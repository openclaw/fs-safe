import type { BigIntStats } from "node:fs";
import { FsSafeError } from "./errors.js";

type ExactFileIdentity = Pick<BigIntStats, "dev" | "ino">;

function identityMismatch(): FsSafeError {
  return new FsSafeError("path-mismatch", "file identity changed or could not be verified");
}

function identityCheck(expected: ExactFileIdentity | undefined, platform: NodeJS.Platform) {
  const known: Partial<ExactFileIdentity> = {};
  const check = (stat: ExactFileIdentity): boolean => {
    let complete = true;
    for (const field of ["dev", "ino"] as const) {
      const value = stat[field];
      // Numeric receipts cannot recover identity bits already lost to rounding.
      if (typeof value !== "bigint") throw identityMismatch();
      if (platform === "win32" && value === 0n) {
        complete = false;
      } else {
        if (known[field] !== undefined && known[field] !== value) throw identityMismatch();
        known[field] = value;
      }
    }
    return complete;
  };
  if (expected && !check(expected)) throw identityMismatch();
  return check;
}

// Retry only unknown Windows identities, retaining every known component so a
// later observation cannot erase a definite mismatch. Never reopen the file.
export async function inspectFileIdentity<T extends ExactFileIdentity>(
  inspect: () => Promise<T>,
  expected?: ExactFileIdentity,
  platform: NodeJS.Platform = process.platform,
): Promise<T> {
  const check = identityCheck(expected, platform);
  for (let attempt = 0; attempt < 2; attempt++) {
    const stat = await inspect();
    if (check(stat)) return stat;
  }
  throw identityMismatch();
}

export function inspectFileIdentitySync<T extends ExactFileIdentity>(
  inspect: () => T,
  expected?: ExactFileIdentity,
  platform: NodeJS.Platform = process.platform,
): T {
  const check = identityCheck(expected, platform);
  for (let attempt = 0; attempt < 2; attempt++) {
    const stat = inspect();
    if (check(stat)) return stat;
  }
  throw identityMismatch();
}
