export const NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH =
  "FS_SAFE_INTERNAL_RENAME_SOURCE_IDENTITY_MISMATCH";

export type NativeRenameFailureOutcome = "uncommitted" | "indeterminate";

export function classifyNativeRenameFailure(error: unknown): NativeRenameFailureOutcome {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
  // Ordinary errno can follow a committed remote rename whose reply was lost.
  return code === NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH
    ? "uncommitted"
    : "indeterminate";
}
