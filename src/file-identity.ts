import { createHash } from "node:crypto";

export type FileIdentityStat = {
  dev: number | bigint;
  ino: number | bigint;
};

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
  left: FileIdentityStat,
  right: FileIdentityStat,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // When Windows cannot open a path for stat, libuv's FindFirstFile fallback reports dev=0 and
  // ino=0. Treating either unknown value as a mismatch caused nondeterministic path-mismatch
  // failures on legitimate reads under antivirus or indexer contention.
  return (
    !isStatValueProvablyDifferent(left.dev, right.dev, platform) &&
    !isStatValueProvablyDifferent(left.ino, right.ino, platform)
  );
}
