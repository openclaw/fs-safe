export type StagedFileReceipt = Readonly<{
  directory: Readonly<{
    path: string;
    realPath: string;
    identity: Readonly<{ dev: bigint; ino: bigint }>;
  }>;
  temporaryBasename: string;
  /** Preparation-time metadata of the private stage, not a final-file fingerprint. */
  identity: Readonly<{
    dev: bigint;
    ino: bigint;
    mode: number;
    nlink: bigint;
    size: bigint;
    uid: number;
    gid: number;
    mtimeNs: bigint;
    ctimeNs: bigint;
  }>;
}>;

export type PublishedFileReceipt = Readonly<{
  status: "published";
  staged: StagedFileReceipt;
  basename: string;
  overwrite: boolean;
}>;

export type StagedFilePublication =
  | Readonly<{ status: "not-published" }>
  | PublishedFileReceipt
  | Readonly<{ status: "indeterminate"; basename: string; overwrite: boolean }>;

export type StagedFileCleanupReceipt = Readonly<{
  temporaryBasename: string;
  publication: StagedFilePublication;
  status: "removed" | "name-absent" | "preserved" | "failed" | "not-needed";
  resources: "closed" | "close-failed";
}>;

export type StagedFileFailureDetails = Readonly<{
  phase: "prepare" | "publish" | "cleanup";
  publication: StagedFilePublication;
  cleanup?: StagedFileCleanupReceipt;
}>;

export interface StagedFile extends AsyncDisposable {
  readonly receipt: StagedFileReceipt;
  assertCurrent(): Promise<void>;
  publish(basename: string, options: { overwrite: boolean }): Promise<PublishedFileReceipt>;
  cleanup(): Promise<StagedFileCleanupReceipt>;
}
