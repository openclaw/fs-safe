import { FsSafeError } from "./errors.js";

/** Preserve verified existing directories; finalize exclusively created directories at 0700. */
export type DirectoryMode = number | "preserve";

export function rejectPrivateDirectoryPreservation(mode: DirectoryMode | undefined): asserts mode is number | undefined {
  if (mode === "preserve") {
    throw new FsSafeError("invalid-path", "Private directories require an explicit numeric dirMode; preservation is not supported.");
  }
}
