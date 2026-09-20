import fs from "node:fs";
import { normalizeMaxBytes } from "./byte-budget.js";
import { FsSafeError } from "./errors.js";
import { readFileWindowFullySync } from "./positional-read.js";

export type SameFileContentsOptions = {
  maxBytes?: number;
};

/** Compares borrowed regular files from offset zero without moving or closing either descriptor. */
export function sameFileContentsSync(
  leftFd: number,
  rightFd: number,
  options: SameFileContentsOptions = {},
): boolean {
  const maxBytes = normalizeMaxBytes(options.maxBytes) ?? Infinity;
  const limit = Math.min(maxBytes, Number.MAX_SAFE_INTEGER);
  const tooLarge = () => new FsSafeError("too-large", `file comparison exceeds ${limit} bytes`);
  for (const fd of [leftFd, rightFd]) {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) {
      throw new FsSafeError("not-file", "file comparison requires regular-file descriptors");
    }
    if (stat.size > BigInt(limit)) throw tooLarge();
  }

  const left = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, limit)));
  const right = Buffer.allocUnsafe(left.length);
  let position = 0;
  while (true) {
    const length = Math.min(left.length, limit - position);
    if (length === 0) {
      // Probe EOF at the limit without forming an unsafe exclusive window end.
      const leftExtra = fs.readSync(leftFd, left, 0, 1, position);
      const rightExtra = fs.readSync(rightFd, right, 0, 1, position);
      if (leftExtra !== 0 || rightExtra !== 0) throw tooLarge();
      return true;
    }
    const leftRead = readFileWindowFullySync(leftFd, left.subarray(0, length), position);
    const rightRead = readFileWindowFullySync(rightFd, right.subarray(0, length), position);
    if (leftRead !== rightRead || !left.subarray(0, leftRead).equals(right.subarray(0, rightRead))) {
      return false;
    }
    if (leftRead < length) return true;
    position += leftRead;
  }
}
