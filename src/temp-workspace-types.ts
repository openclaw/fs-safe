import type { FileStore, FileStoreSync } from "./file-store.js";
import type { TempPathIdentityReceipt } from "./temp-cleanup.js";
import type { TempWorkspaceCleanupMechanism, TempWorkspaceCleanupResult, TempWorkspaceCleanupSafety } from "./temp-workspace-owner.js";

export type TempWorkspaceOptions = {
  rootDir: string;
  prefix: string;
  dirMode?: number;
  mode?: number;
  cleanupSafety?: TempWorkspaceCleanupSafety;
};

export type TempWorkspace = {
  readonly cleanupMechanism: TempWorkspaceCleanupMechanism;
  dir: string;
  identity: TempPathIdentityReceipt;
  store: FileStore;
  path(fileName: string): string;
  write(fileName: string, data: string | Uint8Array): Promise<string>;
  writeText(fileName: string, data: string): Promise<string>;
  writeJson(
    fileName: string,
    data: unknown,
    options?: { trailingNewline?: boolean },
  ): Promise<string>;
  copyIn(fileName: string, sourcePath: string): Promise<string>;
  read(fileName: string): Promise<Buffer>;
  cleanup(): Promise<TempWorkspaceCleanupResult>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type TempWorkspaceSync = {
  readonly cleanupMechanism: TempWorkspaceCleanupMechanism;
  dir: string;
  identity: TempPathIdentityReceipt;
  store: FileStoreSync;
  path(fileName: string): string;
  write(fileName: string, data: string | Uint8Array): string;
  writeText(fileName: string, data: string): string;
  writeJson(fileName: string, data: unknown, options?: { trailingNewline?: boolean }): string;
  read(fileName: string): Buffer;
  cleanup(): TempWorkspaceCleanupResult;
  [Symbol.dispose](): void;
};
