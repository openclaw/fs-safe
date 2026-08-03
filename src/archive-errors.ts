export type ArchiveFormatErrorCode = "archive-header-invalid";

export type ArchiveSecurityErrorCode =
  | "destination-not-directory"
  | "destination-symlink"
  | "destination-symlink-traversal"
  | "entry-filtered"
  | "entry-link"
  | "entry-path";

export class ArchiveSecurityError extends Error {
  readonly code: ArchiveSecurityErrorCode;

  constructor(code: ArchiveSecurityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "ArchiveSecurityError";
  }
}

export class ArchiveFormatError extends Error {
  readonly code: ArchiveFormatErrorCode;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArchiveFormatError";
    this.code = "archive-header-invalid";
  }
}

export function isArchiveFormatErrorMessage(message: string): boolean {
  return (
    message.includes("archive-header-invalid") ||
    message.includes("archive entry size did not match its manifest")
  );
}
