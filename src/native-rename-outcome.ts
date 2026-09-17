export const NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH =
  "FS_SAFE_INTERNAL_RENAME_SOURCE_IDENTITY_MISMATCH";

const DEFINITELY_UNCOMMITTED_NATIVE_RENAME_ERRORS = new Set([
  "EACCES", "EBADF", "EBUSY", "EEXIST", "EINVAL", "EISDIR", "ELOOP", "EMLINK",
  "ENAMETOOLONG", "ENOENT", "ENOSPC", "ENOSYS", "ENOTDIR", "ENOTEMPTY", "ENOTSUP",
  "EOPNOTSUPP", "EPERM", "EROFS", "ETXTBSY", "EXDEV",
  NATIVE_RENAME_SOURCE_IDENTITY_MISMATCH,
]);

export type NativeRenameFailureOutcome = "uncommitted" | "indeterminate";

export function classifyNativeRenameFailure(error: unknown): NativeRenameFailureOutcome {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "";
  return DEFINITELY_UNCOMMITTED_NATIVE_RENAME_ERRORS.has(code)
    ? "uncommitted"
    : "indeterminate";
}
