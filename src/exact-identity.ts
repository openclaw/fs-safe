import fs, { type BigIntStats, type Stats } from "node:fs";
import { FsSafeError } from "./errors.js";

export type ExactFileIdentity = Readonly<{ dev: bigint; ino: bigint }>;
export type ExactIdentityReceipt = { readonly exactIdentity: ExactFileIdentity };

/** Copy scalars from one observation; never try to recover rounded identity bits. */
export function exactFileIdentity(stat: { dev: number | bigint; ino: number | bigint }): ExactFileIdentity {
  const { dev, ino } = stat;
  if ((typeof dev !== "bigint" && !Number.isSafeInteger(dev)) ||
    (typeof ino !== "bigint" && !Number.isSafeInteger(ino))) {
    throw new FsSafeError("path-mismatch", "file identity is not exact");
  }
  return Object.freeze({ dev: BigInt(dev), ino: BigInt(ino) });
}

/** Node stores unsigned libuv fields in a signed BigInt64Array. */
export function numberStatScalar(value: number | bigint): number {
  return typeof value === "bigint" ? Number(BigInt.asUintN(64, value)) : Number(value);
}

/** Legacy metadata view of the very same bigint observation. */
export function numberStats(stat: BigIntStats): Stats {
  const result = Object.create(fs.Stats.prototype) as Stats;
  for (const field of ["dev", "mode", "nlink", "uid", "gid", "rdev", "blksize", "ino", "size", "blocks"] as const) {
    result[field] = numberStatScalar(stat[field]);
  }
  for (const field of ["atime", "mtime", "ctime", "birthtime"] as const) {
    const ns = stat[`${field}Ns`];
    const remainder = ((ns % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
    result[`${field}Ms`] = Number((ns - remainder) / 1_000_000_000n) * 1_000 + Number(remainder) / 1_000_000;
    // Stats.prototype supplies Node's lazy, correctly rounded Date getters.
  }
  return result;
}
