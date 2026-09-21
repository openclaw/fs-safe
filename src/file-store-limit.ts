import { FsSafeError } from "./errors.js";

// Store operation boundaries admit the primitive limit before reaching this helper.
export function assertFileStoreMaxBytes(size: number, limit: number | undefined): void {
  if (limit !== undefined && size > limit) {
    throw new FsSafeError("too-large", `file exceeds maximum size of ${limit} bytes`);
  }
}
