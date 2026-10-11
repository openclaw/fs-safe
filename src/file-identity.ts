import type { ExactIdentityReceipt } from "./exact-identity.js";
export type { ExactFileIdentity, ExactIdentityReceipt } from "./exact-identity.js";
import { createHash } from "node:crypto";

export type FileIdentityStat = {
  dev: number | bigint;
  ino: number | bigint;
};

export type FileIdentityInput = FileIdentityStat | ExactIdentityReceipt;

/** Only the explicit companion is unambiguous; nested source/target receipts are not inferred. */
export function identityFromReceipt(value: FileIdentityInput): FileIdentityStat {
  if ("exactIdentity" in value) {
    const exact = value.exactIdentity;
    const dev = exact?.dev, ino = exact?.ino;
    // A malformed explicit companion cannot fall back to a lossy legacy view.
    return typeof dev === "bigint" && typeof ino === "bigint" ? { dev, ino } : { dev: NaN, ino: NaN };
  }
  return value;
}

export function hasSafeFileIdentity(identity: FileIdentityStat): boolean {
  return isExactStatValue(identity.dev) && isExactStatValue(identity.ino);
}

function isExactStatValue(value: number | bigint): boolean {
  return typeof value === "bigint" || Number.isSafeInteger(value);
}

function isZero(value: number | bigint): boolean {
  return value === 0 || value === 0n;
}

function sameStatValue(left: number | bigint, right: number | bigint): boolean {
  return typeof left === typeof right ? left === right : BigInt(left) === BigInt(right);
}

function isStatValueProvablyDifferent(
  left: number | bigint,
  right: number | bigint,
  platform: NodeJS.Platform,
): boolean {
  if (sameStatValue(left, right)) {
    return false;
  }

  return platform !== "win32" || (!isZero(left) && !isZero(right));
}

export function sha256Hex(data: string | Buffer, encoding?: BufferEncoding): string {
  const buffer = typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data;
  return createHash("sha256").update(buffer).digest("hex");
}

export function sameFileIdentity(
  left: FileIdentityInput,
  right: FileIdentityInput,
  platform: NodeJS.Platform = process.platform,
): boolean {
  left = identityFromReceipt(left);
  right = identityFromReceipt(right);
  const leftDev = left.dev;
  const leftIno = left.ino;
  const rightDev = right.dev;
  const rightIno = right.ino;
  // When Windows cannot open a path for stat, libuv's FindFirstFile fallback reports dev=0 and
  // ino=0. Treating either unknown value as a mismatch caused nondeterministic path-mismatch
  // failures on legitimate reads under antivirus or indexer contention.
  return (
    isExactStatValue(leftDev) && isExactStatValue(leftIno) &&
    isExactStatValue(rightDev) && isExactStatValue(rightIno) &&
    !isStatValueProvablyDifferent(leftDev, rightDev, platform) &&
    !isStatValueProvablyDifferent(leftIno, rightIno, platform)
  );
}

function sameCleanupStatValue(left: number | bigint, right: number | bigint): boolean {
  // Converting an unsafe number to bigint cannot recover an already rounded ID.
  if (!isExactStatValue(left) || !isExactStatValue(right)) return false;
  return sameStatValue(left, right);
}

export function sameFileIdentityForCleanup(
  left: FileIdentityStat,
  right: FileIdentityStat,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") {
    return sameCleanupStatValue(left.dev, right.dev) && sameCleanupStatValue(left.ino, right.ino);
  }

  // Unknown Windows identity components cannot authorize cleanup: a replacement
  // could share the known component. Snapshot adapter-backed fields once so
  // changing accessors cannot alter the check.
  const leftDev = left.dev;
  if (isZero(leftDev)) return false;
  const leftIno = left.ino;
  if (isZero(leftIno)) return false;
  const rightDev = right.dev;
  if (isZero(rightDev)) return false;
  const rightIno = right.ino;
  if (isZero(rightIno)) return false;

  return sameCleanupStatValue(leftDev, rightDev) && sameCleanupStatValue(leftIno, rightIno);
}
