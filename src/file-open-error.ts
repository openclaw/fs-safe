import { formatErrorDetail } from "./error-detail.js";

/** Enrich only an attempted open whose absolute pathname is known by its owner. */
export function annotateReadOnlyOpenError(error: unknown, filePath: string): void {
  if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EROFS") return;
  // Keep the original error, code and errno, even if a caller froze its diagnostics.
  try {
    const failure = error as NodeJS.ErrnoException;
    failure.path = filePath;
    failure.syscall = "open";
    failure.message = `EROFS: read-only filesystem, open '${formatErrorDetail(filePath)}'`;
  } catch { /* Diagnostics must not replace the I/O failure. */ }
}
