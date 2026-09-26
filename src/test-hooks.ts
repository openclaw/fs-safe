import type { FileHandle } from "node:fs/promises";
import type { FileIdentityStat } from "./file-identity.js";

export type FsSafeTestHooks = {
  beforeWatchRegistration?: (path: string) => void | Promise<void>;
  afterWatchRegistration?: (path: string) => void | Promise<void>;
  afterWatchBackendCreated?: (root: string, emit: (batch: import("./watch-native.js").NativeWatchBatch) => void) => void;

  afterPreOpenLstat?: (filePath: string) => Promise<void> | void;
  beforeOpen?: (filePath: string, flags: number) => Promise<void> | void;
  afterOpen?: (filePath: string, handle: FileHandle) => Promise<void> | void;
  afterOpenedPathIdentityCheck?: (filePath: string, handle: FileHandle) => Promise<void> | void;
  afterRootReadPathResolution?: (filePath: string) => Promise<void> | void;
  beforeRootReadFinalFence?: (filePath: string, handle: FileHandle) => Promise<void> | void;
  afterRootReadFinalPathIdentityCheck?: (filePath: string, handle: FileHandle) => void;
  beforeArchiveOutputMutation?: (
    operation: "mkdir" | "chmod",
    targetPath: string,
  ) => Promise<void> | void;
  beforeFileStorePruneDescend?: (dirPath: string) => Promise<void> | void;
  beforeFileStoreSyncPrivateWrite?: (filePath: string) => void;
  beforeRootFallbackMutation?: (
    operation: "mkdir" | "move" | "remove",
    targetPath: string,
  ) => Promise<void> | void;
  beforePinnedWriteParentAdmission?: (targetPath: string) => Promise<void> | void;
  beforeRootStatObservation?: (targetPath: string) => Promise<void> | void;
  beforeRootStatInitialObservation?: (targetPath: string) => Promise<void> | void;
  beforeRootListObservation?: (
    directoryPath: string,
    withFileTypes: boolean,
  ) => Promise<void> | void;
  afterPinnedWriteFallbackRename?: (targetPath: string) => Promise<void> | void;
  beforeSiblingTempWrite?: (tempPath: string) => Promise<void> | void;
  beforeSidecarLockSnapshotOpen?: (lockPath: string) => Promise<void> | void;
  beforeRegularFileAppendOpen?: (filePath: string) => Promise<void> | void;
  beforeRegularFileAppendOpenSync?: (filePath: string) => void;
  beforeTempWorkspaceNativeRemoval?: (quarantinePath: string) => Promise<void> | void;
  beforeTempWorkspaceNativeRemovalSync?: (quarantinePath: string) => void;
  beforeTrashMove?: (targetPath: string, destPath: string) => void;
  afterPublishTargetCreated?: (
    method: "hardlink" | "exclusive-copy" | "rename-noreplace",
    targetPath: string,
    identity: FileIdentityStat,
  ) => Promise<void> | void;
  beforePublishDirectorySync?: NonNullable<FsSafeTestHooks["afterPublishTargetCreated"]>;
};

let fsSafeTestHooks: FsSafeTestHooks | undefined;

function allowFsSafeTestHooks(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

export function getFsSafeTestHooks(): FsSafeTestHooks | undefined {
  return fsSafeTestHooks;
}

export function __setFsSafeTestHooksForTest(hooks?: FsSafeTestHooks): void {
  if (hooks && !allowFsSafeTestHooks()) {
    throw new Error("__setFsSafeTestHooksForTest is only available in tests");
  }
  fsSafeTestHooks = hooks;
}
