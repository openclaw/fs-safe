import { normalizeMaxBytes } from "./byte-budget.js";
import type { DenyMutationPolicy } from "./deny-mutations.js";
import type { RenameIdentityPolicy } from "./pinned-write.js";

export const DEFAULT_ROOT_MAX_BYTES = 16 * 1024 * 1024;

export type RootOptions = {
  rootDir: string;
  defaults?: RootDefaults;
};

export type SymlinkPolicy = "reject" | "follow-within-root";
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
};

export type RootReadOptions = Pick<
  RootDefaults,
  "hardlinks" | "maxBytes" | "nonBlockingRead" | "symlinks"
>;

export type RootOpenOptions = Omit<RootReadOptions, "maxBytes">;

export type RootWriteOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations" | "durable" | "mkdir" | "mode" | "renameIdentity"> & {
  encoding?: BufferEncoding;
  overwrite?: boolean;
};

export type RootOpenWritableOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations" | "mkdir" | "mode"> & {
  writeMode?: WritableOpenMode;
};

export type RootCopyOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations" | "durable" | "maxBytes" | "mkdir" | "mode"> & {
  sourceHardlinks?: HardlinkPolicy;
};

export type RootWriteJsonOptions = RootWriteOptions & {
  replacer?: Parameters<typeof JSON.stringify>[1];
  space?: Parameters<typeof JSON.stringify>[2];
  trailingNewline?: boolean;
};

export type RootCreateOptions = Omit<RootWriteOptions, "overwrite">;
export type RootCreateJsonOptions = Omit<RootWriteJsonOptions, "overwrite">;

export type RootAppendOptions = RootWriteOptions & {
  prependNewlineIfNeeded?: boolean;
};

export type RootMoveOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations"> & {
  overwrite?: boolean;
};

export type RootRemoveOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations">;
export type RootMkdirOptions = Pick<RootDefaults, "assertBeforeMutation" | "denyMutations">;

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
  return merged;
}
