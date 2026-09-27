/** Exact producer observations: never supply rounded Number identities. */
export type RetainedFileExpected = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  /** Lowercase SHA-256 of the producer's expected bytes. */
  sha256: string;
}>;

export type RetainedFileIssue = Readonly<{
  phase: string;
  code: string;
  message: string;
  cause?: unknown;
}>;

/** Descriptive facts, not a deletion capability or a durable transaction receipt. */
export type RetainedFileResult = Readonly<{
  status: "unsupported" | "not-attempted" | "preserved-mismatch" | "disposition-accepted"
    | "name-absent-after-settlement" | "failed" | "indeterminate";
  phase: string;
  /** Full native 64-bit volume serial and 128-bit file ID, when observed. */
  identity?: string;
  disposition: "not-attempted" | "accepted" | "rejected" | "indeterminate";
  namespace: "not-observed" | "absent" | "original" | "foreign" | "unknown";
  resources: "closed" | "close-failed";
  persistence: "not-proven";
  errors: readonly RetainedFileIssue[];
}>;

export type RetainedFileReceipt = Readonly<{
  directory: string;
  parent: Readonly<{ dev: bigint; ino: bigint }>;
  basename: string;
  expected: RetainedFileExpected;
  identity: string;
}>;

export interface RetainedFile extends Disposable {
  readonly receipt: RetainedFileReceipt;
  /** One-shot, synchronous authority admission; always settles owned resources. */
  remove(): RetainedFileResult;
  /** Closes only. Never requests deletion, including after an exception. */
  dispose(): RetainedFileResult;
}

export type RetainedFileAdmission =
  | Readonly<{ status: "retained"; file: RetainedFile }>
  | RetainedFileResult;

export type RetainFileInDirectoryOptions = Readonly<{
  directory: string;
  parent: Readonly<{ dev: bigint; ino: bigint }>;
  basename: string;
  expected: RetainedFileExpected;
  assertBeforeMutation: () => void;
  /** Synchronous verification budget, default 16 MiB; maximum 64 MiB. */
  maxBytes?: number;
}>;
