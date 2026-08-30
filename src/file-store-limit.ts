import { normalizeMaxBytes } from "./byte-budget.js";
import { FsSafeError } from "./errors.js";

export function assertFileStoreMaxBytes(size: number, maxBytes?: number): void {
  const limit = normalizeMaxBytes(maxBytes);
  if (limit !== undefined && size > limit) {
    throw new FsSafeError("too-large", `file exceeds maximum size of ${limit} bytes`);
  }
}
