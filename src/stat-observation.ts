import type { BigIntStats, Stats } from "node:fs";
import { FsSafeError } from "./errors.js";
import { recordFileObservationFailure } from "./file-observation.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

export type ExactStatIdentity = Pick<BigIntStats, "dev" | "ino">;
export type StatObservationReceipt = {
  stat: Stats | BigIntStats;
  identity: ExactStatIdentity;
};

type StatObservationResult<CaptureIdentity extends boolean> = CaptureIdentity extends true
  ? StatObservationReceipt
  : Stats | BigIntStats;

function identityMismatch(): never {
  const error = new FsSafeError("path-mismatch", "file identity changed or could not be verified");
  recordFileObservationFailure(error, "identity");
  throw error;
}

function safeNumber(value: number | bigint): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeExpected(identity: ExactStatIdentity): boolean {
  return typeof identity.dev === "bigint" && typeof identity.ino === "bigint" &&
    identity.dev >= 0n && identity.ino >= 0n &&
    identity.dev <= 9007199254740991n && identity.ino <= 9007199254740991n;
}

function observeStatSync<CaptureIdentity extends boolean>(
  inspect: (bigint: boolean) => Stats | BigIntStats,
  expected?: ExactStatIdentity,
  initial?: Stats | BigIntStats,
  platform: NodeJS.Platform = process.platform,
  captureIdentity?: CaptureIdentity,
): StatObservationResult<CaptureIdentity> {
  if (platform === "win32" || (!initial && expected && !safeExpected(expected))) {
    // Preserve the strict Windows unknown-ID retry, including known components
    // and validation of the expected identity before the first observation.
    const stat = inspectFileIdentitySync(() => {
      const current = initial;
      initial = undefined;
      return (current ?? inspect(true)) as BigIntStats;
    }, expected, platform);
    return (captureIdentity
      ? { stat, identity: expected ?? { dev: stat.dev, ino: stat.ino } }
      : stat) as StatObservationResult<CaptureIdentity>;
  }

  const stat = initial ?? inspect(false);
  const { dev: rawDev, ino: rawIno } = stat;
  const numericDev = safeNumber(rawDev);
  const numericIno = safeNumber(rawIno);
  const dev = numericDev ? BigInt(rawDev) : typeof rawDev === "bigint" ? rawDev : undefined;
  const ino = numericIno ? BigInt(rawIno) : typeof rawIno === "bigint" ? rawIno : undefined;
  if (expected && ((dev !== undefined && dev !== expected.dev) ||
    (ino !== undefined && ino !== expected.ino))) identityMismatch();
  if (numericDev && numericIno) {
    return (captureIdentity
      ? { stat, identity: expected ?? { dev: dev!, ino: ino! } }
      : stat) as StatObservationResult<CaptureIdentity>;
  }

  // An unsafe numeric component is unknown, not a rounded identity. Retain
  // every exact component from this observation while obtaining the full ID.
  const exact = inspectFileIdentitySync(() => {
    const current = inspect(true) as BigIntStats;
    if ((dev !== undefined && current.dev !== dev) ||
      (ino !== undefined && current.ino !== ino)) identityMismatch();
    return current;
  }, expected, platform);
  return (captureIdentity
    ? { stat: exact, identity: expected ?? { dev: exact.dev, ino: exact.ino } }
    : exact) as StatObservationResult<CaptureIdentity>;
}

/** Operation-local metadata plus exact identity; never use projected PathStat IDs. */
export function inspectStatObservationSync(
  inspect: (bigint: boolean) => Stats | BigIntStats,
  expected?: ExactStatIdentity,
  initial?: Stats | BigIntStats,
  platform: NodeJS.Platform = process.platform,
): StatObservationReceipt {
  return observeStatSync(inspect, expected, initial, platform, true);
}

/** Revalidate an exact identity without allocating a receipt that the caller will discard. */
export function assertStatObservationSync(
  inspect: (bigint: boolean) => Stats | BigIntStats,
  expected: ExactStatIdentity,
  initial?: Stats | BigIntStats,
  platform: NodeJS.Platform = process.platform,
): Stats | BigIntStats {
  return observeStatSync(inspect, expected, initial, platform, false);
}
