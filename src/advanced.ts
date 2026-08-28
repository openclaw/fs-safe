// Advanced composition surface. These exports are less stable than the focused
// public subpaths; prefer root/json/store/temp/archive unless you are building a
// higher-level primitive.
export { createAsyncLock } from "./async-lock.js";
export {
  stageFileInDirectory,
  type StagedFile,
  type StagedFileReceipt,
  type PublishedFileReceipt,
  type StagedFilePublication,
  type StagedFileCleanupReceipt,
  type StagedFileFailureDetails,
} from "./staged-file.js";
export {
  readFileDescriptorBounded,
  readFileDescriptorBoundedSync,
  readFileHandleBounded,
} from "./bounded-read.js";
export {
  assertNoUnsafeDeviceReadPath,
  isUnsafeDeviceReadPath,
  matchUnsafeDeviceReadPath,
  type UnsafeDeviceReadPathMatch,
  type UnsafeDeviceReadPathOptions,
  type UnsafeDeviceReadPathReason,
} from "./device-path.js";
export {
  assertAbsolutePathInput,
  canonicalPathFromExistingAncestor,
  ensureAbsoluteDirectory,
  findExistingAncestor,
  resolveAbsolutePathForRead,
  resolveAbsolutePathForWrite,
  type AbsolutePathSymlinkPolicy,
  type EnsureAbsoluteDirectoryOptions,
  type EnsureAbsoluteDirectoryResult,
  type ResolvedAbsolutePath,
  type ResolvedWritableAbsolutePath,
} from "./absolute-path.js";
export { sameFileIdentity, type FileIdentityStat } from "./file-identity.js";
export { sanitizeUntrustedFileName } from "./filename.js";
export { pathExists, pathExistsSync } from "./fs.js";
export {
  resolveLocalPathFromRootsSync,
  readLocalFileFromRoots,
  type LocalRootsInputOptions,
  type LocalRootsPathResult,
  type LocalRootsReadResult,
  type ReadLocalFileFromRootsOptions,
  type ResolveLocalPathFromRootsSyncOptions,
} from "./local-roots.js";
export {
  assertNoWindowsNetworkPath,
  basenameFromMediaSource,
  hasEncodedFileUrlSeparator,
  isWindowsDriveLetterPath,
  isWindowsNetworkPath,
  safeFileURLToPath,
  trySafeFileURLToPath,
} from "./local-file-access.js";
export { formatPosixMode } from "./mode.js";
export {
  configureFsSafeLocks,
  getFsSafeLockConfig,
  type FsSafeLockConfig,
} from "./lock-config.js";
export {
  assertNoHardlinkedFinalPath,
  assertNoPathAliasEscape,
  PATH_ALIAS_POLICIES,
  type PathAliasPolicy,
} from "./path-policy.js";
export {
  openRootFile,
  openRootFileSync,
  canUseRootFileOpen,
  matchRootFileOpenFailure,
  type OpenRootFileParams,
  type OpenRootFileSyncParams,
  type RootFileOpenFailure,
  type RootFileOpenFailureReason,
  type RootFileOpenResult,
} from "./root-file.js";
export {
  ROOT_PATH_ALIAS_POLICIES,
  resolvePathViaExistingAncestorSync,
  resolveRootPath,
  resolveRootPathSync,
  type ResolvedRootPath,
  type RootPathAliasPolicy,
} from "./root-path.js";
export {
  ensureDirectoryWithinRoot,
  pathScope,
  resolveExistingPathsWithinRoot,
  resolvePathWithinRoot,
  resolvePathsWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  resolveWritablePathWithinRoot,
  type PathScope,
  type PathScopeOptions,
  type PathScopeResolveOptions,
} from "./root-paths.js";
export {
  safeDirName,
  safePathSegmentHashed,
  resolveSafeInstallDir,
  assertCanonicalPathWithinBase,
} from "./install-path.js";
export {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
  type AssertNoSymlinkParentsOptions,
} from "./symlink-parents.js";
export { movePathToTrash, type MovePathToTrashOptions } from "./trash.js";
export { withTimeout } from "./timing.js";
export { resolveHomeRelativePath } from "./home-dir.js";
export {
  appendRegularFile,
  appendRegularFileSync,
  readRegularFile,
  readRegularFileSync,
  resolveRegularFileAppendFlags,
  statRegularFile,
  statRegularFileSync,
  type AppendRegularFileOptions,
  type RegularFileStatResult,
} from "./regular-file.js";
export {
  buildRandomTempFilePath,
  sanitizeTempFileName,
  type TempFile,
  tempFile,
  withTempFile,
} from "./temp-target.js";
export {
  writeSiblingTempFile,
  writeViaSiblingTempPath,
  type WriteSiblingTempFileOptions,
  type WriteSiblingTempFileResult,
} from "./sibling-temp.js";
export {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  formatWindowsAclSummary,
  inspectWindowsAcl,
  parseIcaclsOutput,
  resolveWindowsUserPrincipal,
  summarizeWindowsAcl,
  type IcaclsResetCommandOptions,
  type PermissionCommandFailure,
  type PermissionExec,
  type WindowsAclEntry,
  type WindowsAclSummary,
} from "./permissions.js";
