import { normalizeMaxBytes } from "./byte-budget.js";
import type { DenyMutationPolicy } from "./deny-mutations.js";
import type { RenameIdentityPolicy } from "./pinned-write-types.js";
import type { MutationSymlinkPolicy, SymlinkPolicy } from "./root-symlink-policy.js";
import type { CopyCloneMode } from "./copy-policy.js";
import type { RootCopyPublicationReceipt } from "./copy-publication.js";
import type { Root } from "./root-impl.js";

export const DEFAULT_ROOT_MAX_BYTES = 16 * 1024 * 1024;

export type RootOptions = {
  rootDir: string;
  defaults?: RootDefaults;
};

export type HardlinkPolicy = "reject" | "allow";
export type WritableOpenMode = "replace" | "append" | "update";

export type RootDefaults = {
  assertBeforeMutation?: () => void;
  durable?: boolean;
  hardlinks?: HardlinkPolicy;
  maxBytes?: number;
  mkdir?: boolean;
  mode?: number;
  denyMutations?: DenyMutationPolicy;
  nonBlockingRead?: boolean;
  renameIdentity?: RenameIdentityPolicy;
  symlinks?: SymlinkPolicy;
  mutationSymlinks?: MutationSymlinkPolicy;
};

export type RootReadOptions = Pick<
  RootDefaults,
  "hardlinks" | "maxBytes" | "nonBlockingRead" | "symlinks"
> & {
  /** Reject observed metadata or byte-count changes; this is not an atomic snapshot. */
  verifyUnchanged?: boolean;
};

export type RootOpenOptions = Omit<RootReadOptions, "maxBytes" | "verifyUnchanged">;

export type RootWriteOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations" | "mutationSymlinks" | "durable" | "mkdir" | "mode" | "renameIdentity"> & {
  encoding?: BufferEncoding;
  overwrite?: boolean;
};

export type RootOpenWritableOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations" | "mutationSymlinks" | "mkdir" | "mode"> & {
  writeMode?: WritableOpenMode;
};

export type RootCopyOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations" | "mutationSymlinks" | "durable" | "maxBytes" | "mkdir" | "mode"> & {
  sourceHardlinks?: HardlinkPolicy;
  overwrite?: boolean;
  clone?: CopyCloneMode;
  signal?: AbortSignal;
  preserveSourceMode?: boolean;
  onDestinationPublished?: (receipt: RootCopyPublicationReceipt) => void;
};

export type RootCopySource = string | { root: Pick<Root, "open" | "stat">; relativePath: string };

export type RootWriteJsonOptions = RootWriteOptions & {
  replacer?: Parameters<typeof JSON.stringify>[1];
  space?: Parameters<typeof JSON.stringify>[2];
  trailingNewline?: boolean;
};

export type RootCreateOptions = Omit<RootWriteOptions, "overwrite" | "durable"> & {
  /** Publish complete content without replacing an existing entry, including without native support. */
  atomic?: boolean;
  private?: boolean;
  /** "file" requires file synchronization; directory synchronization remains best effort. */
  durable?: boolean | "file";
};
export type RootCreateStreamOptions = Omit<RootCreateOptions, "atomic" | "encoding" | "renameIdentity"> & {
  maxBytes?: number;
  signal?: AbortSignal;
};
export type RootCreateJsonOptions = Omit<RootWriteJsonOptions, "overwrite" | "durable"> & Pick<RootCreateOptions, "atomic" | "durable" | "private">;

export type RootAppendOptions = RootWriteOptions & {
  prependNewlineIfNeeded?: boolean;
};

export type RootMoveOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations" | "mutationSymlinks"> & {
  overwrite?: boolean;
};

export type RootRemoveOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations" | "mutationSymlinks"> & {
  recursive?: boolean;
  force?: boolean;
  order?: "filesystem" | "sorted";
  maxEntries?: number;
  maxDepth?: number;
  signal?: AbortSignal;
};
export type RootMkdirOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations" | "mutationSymlinks"> & {
  private?: boolean;
};

export type RootReadParams = Omit<RootReadOptions, "nonBlockingRead">;

export function readDefaults(defaults: RootDefaults): RootReadParams {
  return {
    hardlinks: defaults.hardlinks,
    maxBytes: normalizeMaxBytes(defaults.maxBytes, { defaultValue: DEFAULT_ROOT_MAX_BYTES }),
    symlinks: defaults.symlinks,
  };
}

export function mergeReadOptions(defaults: RootDefaults, options: RootReadOptions): RootReadParams {
  const merged = readDefaults(defaults);
  if (options.hardlinks !== undefined) merged.hardlinks = options.hardlinks;
  merged.maxBytes = normalizeMaxBytes(options.maxBytes, { defaultValue: merged.maxBytes });
  if (options.symlinks !== undefined) merged.symlinks = options.symlinks;
  merged.verifyUnchanged = options.verifyUnchanged;
  return merged;
}
