export type ZeroRange = Readonly<{ offset: number; length: number }>;

/**
 * Validates caller ranges and returns them sorted and merged. Bytes inside a range
 * are never read and stand for zeros: regions another process may lock, such as
 * SQLite's lock bytes on Windows, that hold no content.
 */
export function normalizeZeroRanges(ranges: readonly ZeroRange[] | undefined): ZeroRange[] {
  if (ranges === undefined) return [];
  if (!Array.isArray(ranges)) throw new TypeError("zeroRanges must be an array");
  const sorted = ranges.map(({ offset, length }: ZeroRange) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 ||
      !Number.isSafeInteger(offset + length)) {
      throw new RangeError("zeroRanges entries need a non-negative safe offset and a positive safe length");
    }
    return { offset, length };
  }).sort((left, right) => left.offset - right.offset);
  const merged: { offset: number; length: number }[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.offset <= last.offset + last.length) {
      last.length = Math.max(last.length, range.offset + range.length - last.offset);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/**
 * The next step from `position` in a file of `size` bytes: a count of zero bytes standing
 * for a range, or the longest read of at most `length` bytes that enters no range.
 */
export function zeroRangeStep(
  ranges: readonly ZeroRange[],
  position: number,
  length: number,
  size: number,
): { zeros: number } | { read: number } {
  for (const range of ranges) {
    const end = range.offset + range.length;
    if (position >= end) continue;
    if (position >= range.offset) {
      // Zeros never extend a file: at or past its end, a read observes EOF.
      const zeros = Math.min(end, size) - position;
      return zeros > 0 ? { zeros: Math.min(zeros, length) } : { read: length };
    }
    return { read: Math.min(length, range.offset - position) };
  }
  return { read: length };
}
