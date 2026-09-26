import type syncFs from "node:fs";
import type fs from "node:fs/promises";
import type { RenameIdentityPolicy } from "./pinned-write-types.js";
import type { AtomicMutationOptions } from "./replace-file-mutation.js";
import type { ReplaceFileCopyFallbackRestorePolicy, ReplaceFileDestinationHardlinkPolicy } from "./replace-file-copy-fallback.js";

export type ReplaceFileAtomicFileSystem = {
  promises: Pick<
    typeof fs,
    | "mkdir"
    | "writeFile"
    | "rename"
    | "copyFile"
    | "unlink"
    | "rm"
    | "open"
    | "stat"
    | "lstat"
  > & {
    /** @deprecated Accepted for adapter compatibility but never called. */
    chmod?: typeof fs.chmod;
  };
};

export type ReplaceFileAtomicSyncFileSystem = Pick<
  typeof syncFs,
  | "mkdirSync"
  | "readFileSync"
  | "writeFileSync"
  | "renameSync"
  | "copyFileSync"
  | "unlinkSync"
  | "rmSync"
  | "openSync"
  | "fsyncSync"
  | "closeSync"
  | "fstatSync"
  | "statSync"
  | "lstatSync"
  | "ftruncateSync"
  | "readSync"
  | "writeSync"
> & {
  /** @deprecated Accepted for adapter compatibility but never called. */
  chmodSync?: typeof syncFs.chmodSync;
  fchmodSync?: typeof syncFs.fchmodSync;
};

export type ReplaceFileAtomicBaseOptions = AtomicMutationOptions & {
  filePath: string;
  content: string | Uint8Array;
  dirMode?: number;
  mode?: number;
  /** Inherit only rwx bits from an existing non-symlink regular file. */
  preserveExistingMode?: boolean;
  tempPrefix?: string;
  renameMaxRetries?: number;
  renameRetryBaseDelayMs?: number;
  copyFallbackOnPermissionError?: boolean;
  copyFallbackRestore?: ReplaceFileCopyFallbackRestorePolicy;
  maxRestoreBytes?: number;
  destinationHardlinks?: ReplaceFileDestinationHardlinkPolicy;
  /** Strict by default; locked content verification is an explicit FUSE compatibility policy. */
  renameIdentity?: RenameIdentityPolicy;
  syncTempFile?: boolean;
  syncParentDir?: boolean;
  throwOnCleanupError?: boolean;
};

export type ReplaceFileAtomicOptions = ReplaceFileAtomicBaseOptions & {
  fileSystem?: ReplaceFileAtomicFileSystem;
  /** Runs while the exact staged file is retained; replacing or hardlinking it is rejected. */
  beforeRename?: (params: { filePath: string; tempPath: string }) => Promise<void>;
};

export type ReplaceFileAtomicSyncOptions = ReplaceFileAtomicBaseOptions & {
  fileSystem?: ReplaceFileAtomicSyncFileSystem;
  /** Runs while the exact staged file is retained; replacing or hardlinking it is rejected. */
  beforeRename?: (params: { filePath: string; tempPath: string }) => void;
};

export type ReplaceFileAtomicResult = {
  method: "rename" | "copy-fallback";
};

