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

export interface NativeArchiveEntry {
  index: number;
  path: string;
  kind: string;
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

export interface NativeOpenBeneathResult {
  fd: number;
  containment: "kernel-atomic" | "best-effort";
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

export interface NativeBinding {
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
    maxMetaEntryBytes: number,
    signal: AbortSignal,
  ): Promise<void>;
  fstatIdentity(fd: number): NativeFileIdentity;
  inspectArchiveNative(
    path: string,
    kind: string,
    maxEntries: number,
    maxMetaEntryBytes: number,
    maxManifestBytes: number,
    signal: AbortSignal,
  ): Promise<NativeArchiveEntry[]>;
  linkBeneath(
    sourceRootFd: number,
    sourceRelPath: string,
    targetRootFd: number,
    targetRelPath: string,
  ): void;
  mkdirBeneath(rootFd: number, relPath: string, mode: number): void;
  openBeneath(rootFd: number, relPath: string, flags: number): NativeOpenBeneathResult;
  readArchiveEntryNative(
    path: string,
    kind: string,
    requested: string,
    maxBytes: number,
    maxEntries: number,
    maxMetaEntryBytes: number,
    signal: AbortSignal,
  ): Promise<Buffer>;
  readOwnerAndDacl(path: string): NativeWindowsSecurityFacts;
  renameNoReplace(
    sourceRootFd: number,
    sourceRelPath: string,
    targetRootFd: number,
    targetRelPath: string,
  ): void;
  sha256File(fd: number): Promise<NativeFileHash>;
}
