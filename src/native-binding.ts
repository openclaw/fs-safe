import type { TarMeterLimits } from "./archive-limits.js";
import type { ArchiveMemberKind } from "./archive-plan.js";
import type { CopyCloneMode } from "./copy-policy.js";
import { FsSafeError } from "./errors.js";

export interface NativeFileHash {
  bytes: number;
  digest: string;
}

export interface NativeFileIdentity {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface NativeDirectoryObservation {
  dev: bigint;
  ino: bigint;
  realPath: string;
}

export interface NativeDirectoryFdObservation extends NativeDirectoryObservation {
  mode: bigint;
  nlink: bigint;
}

export interface NativeArchiveEntry {
  index: number;
  path: string;
  kind: ArchiveMemberKind;
  size: number;
  mode: number;
}

export interface NativeArchivePlanEntry extends NativeArchiveEntry {}

export interface NativeCopyResult {
  fd: number;
  bytes: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface NativeFileCopyResult {
  fd: number;
  method: "clone" | "copy-file-range" | "copy";
  errorCode?: string;
  errorMessage?: string;
}

export interface NativeOpenBeneathResult {
  fd: number;
  containment: "kernel-atomic" | "best-effort";
}

export interface NativeOwnedTreeRemovalResult {
  outcome?: "removed" | "preserved";
  errorCode?: string;
  errorMessage?: string;
}

export interface NativeWindowsAccessControlEntry {
  sid: string;
  mask: number;
  aceType: string;
  flags: {
    raw: number;
    objectInherit: boolean;
    containerInherit: boolean;
    noPropagateInherit: boolean;
    inheritOnly: boolean;
    inherited: boolean;
    successfulAccess: boolean;
    failedAccess: boolean;
  };
}

export interface NativeWindowsSecurityFacts {
  ownerSid: string;
  currentUserSid: string;
  ownerClass: string;
  worldWritable: boolean;
  groupWritable: boolean;
  worldReadable: boolean;
  groupReadable: boolean;
  fallbackRequired: boolean;
  daclPresent: boolean;
  isLocal: boolean;
  aceListComplete: boolean;
  unsupportedAceTypes: number[];
  aces: NativeWindowsAccessControlEntry[];
}

export interface NativeWindowsDescriptorSecurityFacts {
  /** Canonical lowercase 32-bit volume serial and 64-bit file-index projection used by Node. */
  identity: string;
  security: NativeWindowsSecurityFacts;
}

export interface NativeDarwinAclFacts {
  state: "absent" | "empty" | "present";
}

export interface NativeBinding {
  /** Internal: consumes only a descriptor returned by this binding. */
  closeOwnedFd(fd: number): void;
  /** Internal Darwin-only synchronous inspection; the caller retains its fd. */
  inspectDarwinAcl?(fd: number): NativeDarwinAclFacts;
  /** POSIX system canonicalization; confinement and identity policy stay with callers. */
  canonicalizePath?(path: string, ordinary: boolean): { path?: string; errno?: number };
  /** Internal: exact directory identity and canonical path from one no-follow handle. */
  observeDirectory?(path: string): NativeDirectoryObservation;
  /** Internal POSIX-only exact name/descriptor observation; the caller retains its fd. */
  observeDirectoryFd?(fd: number, expectedPath: string): NativeDirectoryFdObservation;
  /** Linux/Windows byte transfer; callers retain both admitted descriptors until settlement. */
  copyFileContents?(sourceFd: number, targetFd: number, signal?: AbortSignal): Promise<void>;
  /** Internal: same private, immutable input ownership as the ZIP buffer reader. */
  openTarBufferNative(buffer: Buffer, kind: string, limits: TarMeterLimits, signal?: AbortSignal): Promise<{
    readonly entries: NativeArchiveEntry[];
    readEntry(index: number, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
  }>;
  /** Internal: input remains private, unpooled and immutable until the reader is released. */
  openZipBufferNative(buffer: Buffer, limits: TarMeterLimits, signal?: AbortSignal): Promise<{
    readonly entries: NativeArchiveEntry[];
    readEntry(index: number, maxBytes: number, signal?: AbortSignal): Promise<Buffer>;
  }>;
  readCloneFileMetadata(paths: string[]): Promise<(Buffer | null)[]>;
  probeTreeClone(parentFd: number): "apfs" | "btrfs" | "refs" | "xfs" | "zfs" | null;
  cloneTree(
    sourceFd: number | null,
    parentFd: number,
    basename: string,
    concurrency: number,
    signal?: AbortSignal,
  ): Promise<void>;
  // POSIX-only direct-child staging; the matching Windows binary omits these methods.
  createStagedFile?(parentFd: number, basename: string): number;
  stagedFileMatches?(parentFd: number, basename: string, fileFd: number): boolean;
  removeStagedFile?(
    parentFd: number,
    basename: string,
    fileFd: number,
  ): "removed" | "name-absent" | "preserved";
  copyFileExclusive?(
    sourceFd: number,
    parentFd: number,
    basename: string,
    clone: CopyCloneMode,
    maxBytes: number | undefined,
    signal: AbortSignal | undefined,
    sync: boolean,
  ): Promise<NativeFileCopyResult>;
  cloneFileExclusive(sourceFd: number, targetRootFd: number, targetRelPath: string): number;
  copyFileRangeExclusive(
    sourceFd: number,
    targetRootFd: number,
    targetRelPath: string,
  ): Promise<NativeCopyResult>;
  createPrivateDirectory(path: string): void;
  extractArchiveNative(
    path: string,
    kind: string,
    rootFd: number,
    plan: NativeArchivePlanEntry[],
    limits: TarMeterLimits,
    signal: AbortSignal,
  ): Promise<void>;
  fstatIdentity(fd: number): NativeFileIdentity;
  inspectArchiveNative(
    path: string,
    kind: string,
    limits: TarMeterLimits,
    signal: AbortSignal,
  ): Promise<NativeArchiveEntry[]>;
  linkBeneath(
    sourceRootFd: number,
    sourceRelPath: string,
    targetRootFd: number,
    targetRelPath: string,
  ): void;
  /** Direct-child mkdir; true is receipt provenance only, never cleanup ownership. */
  mkdirChildBeneath?(parentFd: number, basename: string, mode: number): boolean;
  mkdirBeneath(rootFd: number, relPath: string, mode: number): void;
  openBeneath(rootFd: number, relPath: string, flags: number): NativeOpenBeneathResult;
  readArchiveEntryNative(
    path: string,
    kind: string,
    requested: string,
    maxBytes: number,
    limits: TarMeterLimits,
    signal: AbortSignal,
  ): Promise<Buffer>;
  readOwnerAndDacl(path: string): NativeWindowsSecurityFacts;
  /** Internal Windows-only inspection of the exact borrowed Node descriptor. */
  inspectWindowsSecureFileHandle?(fd: number): NativeWindowsDescriptorSecurityFacts;
  ownedTreeRemovalAvailable?(parentFd: number): boolean;
  removeOwnedTree?(
    parentFd: number,
    basename: string,
    directoryFd: number,
  ): Promise<NativeOwnedTreeRemovalResult>;
  removeOwnedTreeSync?(
    parentFd: number,
    basename: string,
    directoryFd: number,
  ): NativeOwnedTreeRemovalResult;
  renameNoReplace(
    sourceRootFd: number,
    sourceRelPath: string,
    targetRootFd: number,
    targetRelPath: string,
  ): void;
  renameReplace(
    sourceRootFd: number,
    sourceRelPath: string,
    targetRootFd: number,
    targetRelPath: string,
  ): void;
  sha256File(fd: number, maxBytes?: number, signal?: AbortSignal): Promise<NativeFileHash>;
}

export function captureNativeFdClose(binding: NativeBinding): (fd: number) => void {
  if (typeof binding.closeOwnedFd !== "function") {
    throw new FsSafeError("helper-unavailable", "native descriptor ownership is unavailable");
  }
  // Retained descriptors must remain disposable after native configuration changes.
  return binding.closeOwnedFd.bind(binding);
}
