import { ArchiveSecurityError, isArchiveTarPathErrorMessage } from "./archive-errors.js";
import { ARCHIVE_LIMIT_ERROR_CODE, ArchiveLimitError } from "./archive-limits.js";

export function classifyArchiveParserError(message: string, options?: ErrorOptions): Error | undefined {
  if (isArchiveTarPathErrorMessage(message)) {
    return new ArchiveSecurityError("entry-path", message, options);
  }
  for (const code of Object.values(ARCHIVE_LIMIT_ERROR_CODE)) {
    if (message.includes(code)) return new ArchiveLimitError(code);
  }
  return undefined;
}
