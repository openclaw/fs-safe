import fs from "node:fs";
import { normalizeMaxBytes } from "./byte-budget.js";
import { FsSafeError } from "./errors.js";
import { readFileWindowFullySync } from "./positional-read.js";
import { normalizeZeroRanges, zeroRangeStep, type ZeroRange } from "./zero-ranges.js";

export type SameFileContentsOptions = {
  maxBytes?: number;
  /** Byte ranges compared as zeros in both files without being read. */
  zeroRanges?: readonly ZeroRange[];
};

/** Compares borrowed regular files from offset zero without moving or closing either descriptor. */
export function sameFileContentsSync(
  leftFd: number,
  rightFd: number,
  options: SameFileContentsOptions = {},
): boolean {
  const maxBytes = normalizeMaxBytes(options.maxBytes) ?? Infinity;
  const limit = Math.min(maxBytes, Number.MAX_SAFE_INTEGER);
  const ranges = normalizeZeroRanges(options.zeroRanges);
  const tooLarge = () => new FsSafeError("too-large", `file comparison exceeds ${limit} bytes`);
  const admittedSize = (fd: number) => {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) {
      throw new FsSafeError("not-file", "file comparison requires regular-file descriptors");
    }
    if (stat.size > BigInt(limit)) throw tooLarge();
    return Number(stat.size);
  };
  const leftSize = admittedSize(leftFd);
  const rightSize = admittedSize(rightFd);

  const left = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, limit)));
  const right = Buffer.allocUnsafe(left.length);
  let position = 0;
  while (true) {
    let length = Math.min(left.length, limit - position);
    if (ranges.length > 0 && length > 0) {
      const leftStep = zeroRangeStep(ranges, position, length, leftSize);
      const rightStep = zeroRangeStep(ranges, position, length, rightSize);
      if ("zeros" in leftStep || "zeros" in rightStep) {
        // A skipped range still requires both files to extend equally through it.
        if (!("zeros" in leftStep && "zeros" in rightStep) || leftStep.zeros !== rightStep.zeros) return false;
        position += leftStep.zeros;
        continue;
      }
      length = Math.min(leftStep.read, rightStep.read);
    }
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
