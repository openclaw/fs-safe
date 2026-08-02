# Public API inventory

This page closes the gap between the narrative guides and the complete package
surface. The generated declarations define the exact signatures; the lists
below name the lower-frequency exports that are easy to miss when reading only
the focused guides. `test/public-api.json` guards the same inventory during
pack checks.

## Main entry and `root`

The main entry and `@openclaw/fs-safe/root` expose the root capability types,
including `ContainmentGuarantee`, `RootOpenOptions`, `RootCreateOptions`,
`RootCreateJsonOptions`, and `WritableOpenMode`. The root-bounded iterator uses
`RootWalkOptions`, `RootWalkEntry`, `RootWalkDataEntry`, `RootWalkEntryKind`,
`RootWalkDataEntryKind`, `RootWalkSymlinkPolicy`, `RootWalkLimitBehavior`,
`RootWalkDirectoryErrorBehavior`, `RootWalkEntryFilter`, and
`RootWalkEntryFilterResult`.

The root subpath also exports `openLocalFileSafely`, `readLocalFileSafely`, and
`resolveOpenedFileRealPathForHandle` for trusted absolute-file composition.
They do not create a root boundary around arbitrary caller input; prefer
`root()` for untrusted paths.

The error helpers are `categorizeFsSafeError` and `FsSafeErrorDetails`. The
deprecated native-configuration bridge retains the `FsSafePythonConfig` type.

## `path` and `advanced`

The lexical path surface additionally exports `isNodeError`,
`isPathRelativeEscape`, `normalizeWindowsPathForComparison`,
`resolveSafeRelativePath`, `splitSafeRelativePath`, and
`matchUnsafeDeviceReadPath`. The device matcher is described by
`UnsafeDeviceReadPathMatch`, `UnsafeDeviceReadPathOptions`, and
`UnsafeDeviceReadPathReason`.

The advanced root-file primitive exports `OpenRootFileParams`,
`OpenRootFileSyncParams`, `RootFileOpenResult`, and
`RootFileOpenFailureReason`. These are composition types for callers building
their own pinned-open flow, not substitutes for the higher-level `Root` verbs.

## `json` and `store`

Standalone structured reads use `ReadJsonOptions`, `ReadRootJsonSyncOptions`,
`ReadRootStructuredFileSyncOptions`, and `RootStructuredFileReadResult`.

The store surface additionally exports `FileStoreReadOptions` and
`JsonFileStoreOptions`. Durable-queue inspection and recovery use
`jsonDurableQueueEntryExists`, `loadJsonDurableQueueEntry`,
`readJsonDurableQueueEntry`, and the `JsonDurableQueueLoadOptions` and
`JsonDurableQueueReadResult` types. `unlinkBestEffort` is the explicitly
best-effort cleanup helper used by those queue flows.

## Permissions and secure files

Permission inspection exposes `PermissionCheckOptions` and `SafeStatResult`.
Private-directory creation uses `CreatePrivateDirectoryOptions`. Raw Windows
descriptor facts use `OwnerAndDaclResult`, `WindowsAccessControlEntry`, and
`WindowsAceFlags`.

Secure reads split their option and result shapes into
`SecureFileTrustOptions`, `SecureFilePermissionOptions`,
`SecureFileInjectOptions`, `SecureFileIoOptions`, and `SecureFileReadResult`.

## Locks, walking, and temp workspaces

The file-lock diagnostics surface includes `FileLockHeldEntry`,
`FileLockStaleRecovery`, and `SidecarLockCompromisedInfo`.
`drainFileLockManagerForTest` and `resetFileLockManagerForTest` are test-only
manager controls; production code should not use them as lock recovery.

Standalone walkers use the `WalkEntryKind` and `WalkSymlinkPolicy` unions.
Private workspaces expose `TempPathIdentityReceipt` and the
`TempWorkspaceCleanupResult` union so callers can distinguish removal,
absence, and identity mismatch.

## Atomic replacement and durability

Atomic helper option and receipt types include
`MovePathWithCopyFallbackOptions`, `ReplaceDirectoryAtomicOptions`,
`ReplaceFileAtomicSyncOptions`, `ReplaceFileAtomicResult`,
`ReplaceFileAtomicRestoreCleanup`, `ReplaceFileCopyFallbackRestorePolicy`, and
`ReplaceFileDestinationHardlinkPolicy`.

The durability surface also exports the synchronous strict
`syncDirectorySync`, plus `DirectoryReceipt`, `DurableDirectoryReceipt`,
`EnsureDurableDirectoryOptions`, `PublishFileExclusiveResult`,
`PublishFileExclusiveStrategy`, `PublishFileExclusiveCleanup`,
`PublishFileExclusiveFailurePhase`,
`PublishFileExclusiveDirectorySyncFailure`, `Sha256FileInput`, and
`Sha256FileResult`.

## Archives

Archive option and policy types are `ExtractArchiveOptions`,
`ArchiveEntryFilter`, `ArchiveEntryModePolicy`, and
`ArchiveFilteredEntryPolicy`. Typed error-code unions are
`ArchiveFormatErrorCode`, `ArchiveLimitErrorCode`, and
`ArchiveSecurityErrorCode`. TAR and ZIP preflight composition uses
`TarEntryInfo` and `ZipArchiveWithFiles`.

`createArchiveSymlinkTraversalError` constructs the typed traversal failure
used by extractors. `resolvePackedRootDir` finds the single packed root when an
archive layout permits it; neither helper weakens entry validation.

## Keeping this list honest

Every runtime and type name in `test/public-api.json` must appear somewhere in
`README.md` or `docs/`. Documentation examples are also checked so a named
import cannot silently move to another package subpath.
