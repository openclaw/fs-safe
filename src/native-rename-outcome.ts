export const NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH =
  "FS_SAFE_INTERNAL_RENAME_SOURCE_IDENTITY_MISMATCH";

export type NativeRenameFailureOutcome = "uncommitted" | "indeterminate";

export function classifyNativeRenameFailure(error: unknown): NativeRenameFailureOutcome {
  try {
    if ((error as NodeJS.ErrnoException | undefined)?.code === NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH) {
      return "uncommitted";
    }
  } catch {
    // Unreadable diagnostics cannot prove that the rename was uncommitted.
  }
  // Ordinary errno can follow a committed remote rename whose reply was lost.
  return "indeterminate";
}
