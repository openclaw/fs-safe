/** Exact caller observation. Unknown or rounded identities are not admitted. */
export type PublicationIdentity = Readonly<{ dev: bigint; ino: bigint }>;
export type PublicationParent = Readonly<{ path: string; identity: PublicationIdentity }>;
export type RetainEntryForPublicationOptions = Readonly<{
  source: Readonly<{
    parent: PublicationParent;
    basename: string;
    expected: PublicationIdentity & Readonly<{ kind: "directory" | "file" }>;
  }>;
  destination: Readonly<{ parent: PublicationParent; basename: string }>;
  /** Must synchronously throw on loss of caller authority. Does not provide isolation. */
  assertBeforeMutation: () => void;
}>;
export type EntryPublicationReceipt = Readonly<{
  source: RetainEntryForPublicationOptions["source"];
  destination: RetainEntryForPublicationOptions["destination"];
  capability: Readonly<{
    destinationAbsence: "atomic";
    sourceIdentity: "observed-under-caller-exclusive-namespace";
    parentBinding: "retained-object";
    sourceFilesystem: string;
    destinationFilesystem: string;
  }>;
}>;
export type EntryPublicationIssue = Readonly<{
  phase: "admission" | "authority" | "precheck" | "native" | "postcheck" | "close";
  cause: unknown;
}>;
/** In-memory syscall disposition, NOT a crash-durable transaction journal. */
export type EntryPublicationResult = Readonly<{
  transition: "committed" | "not-published" | "indeterminate";
  verification: "not-performed" | "verified" | "failed";
  resources: "closed" | "close-failed";
  /** First issue is primary; subsequent close failures never replace it. */
  issues: readonly EntryPublicationIssue[];
}>;
export interface RetainedEntryPublication extends Disposable {
  readonly receipt: EntryPublicationReceipt;
  /** One-shot, synchronous; returns operation AND close failures without discarding transition. */
  publish(): EntryPublicationResult;
  /** Close only. Never reverses, unlinks, or cleans either name; idempotent. */
  dispose(): EntryPublicationResult;
}
