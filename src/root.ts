export {
  DEFAULT_ROOT_MAX_BYTES,
  openLocalFileSafely,
  readLocalFileSafely,
  resolveOpenedFileRealPathForHandle,
  root,
  type OpenResult,
  type Root,
  type WritableOpenResult,
} from "./root-impl.js";
export type {
  HardlinkPolicy,
  RootAppendOptions,
  RootCopyOptions,
  RootCopySource,
  RootCreateJsonOptions,
  RootCreateOptions,
  RootCreateStreamOptions,
  RootDefaults,
  RootMkdirOptions,
  RootMoveOptions,
  RootOpenOptions,
  RootOpenWritableOptions,
  RootOptions,
  RootReadOptions,
  RootRemoveOptions,
  RootWriteJsonOptions,
  RootWriteOptions,
  WritableOpenMode,
} from "./root-options.js";
export type { DenyMutationPolicy } from "./deny-mutations.js";
export type { RenameIdentityPolicy } from "./pinned-write-types.js";
export type {
  MutationSymlinkPolicy,
  SymlinkPolicy,
} from "./root-symlink-policy.js";
export type { ReadResult } from "./read-opened-file.js";
export type { RootCopyPublicationReceipt } from "./copy-publication.js";
export type { CopyCloneMode } from "./copy-policy.js";
export type { RootEntriesOptions } from "./root-entries.js";
export type { ContainmentGuarantee } from "./containment.js";
export type {
  RootWalkDataEntry,
  RootWalkDataEntryKind,
  RootWalkDirectoryErrorBehavior,
  RootWalkEntry,
  RootWalkEntryFilter,
  RootWalkEntryFilterResult,
  RootWalkEntryKind,
  RootWalkLimitBehavior,
  RootWalkOptions,
  RootWalkSymlinkPolicy,
} from "./root-walk.js";
