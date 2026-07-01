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

export function sha256Hex(data: string | Buffer, encoding?: BufferEncoding): string {
  const buffer = typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data;
  return createHash("sha256").update(buffer).digest("hex");
}

export function sameFileIdentity(
  left: FileIdentityStat,
  right: FileIdentityStat,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!sameStatValue(left.ino, right.ino)) {
    return false;
  }

  // On Windows, path-based stat calls can report dev=0 while fd-based stat
  // reports a real volume serial; treat either-side dev=0 as "unknown device".
  if (sameStatValue(left.dev, right.dev)) {
    return true;
  }
  return platform === "win32" && (isZero(left.dev) || isZero(right.dev));
}
