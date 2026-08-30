import fsSync from "node:fs";
import { sameFileIdentityForCleanup, type FileIdentityStat } from "./file-identity.js";

export type TempPathIdentityReceipt = FileIdentityStat;

export type TempPathRegistration = (() => void) & {
  setIdentity(identity: FileIdentityStat): void;
};

type TempCleanupEntry = {
  path: string;
  recursive: boolean;
  identity?: FileIdentityStat;
  singleLinkFile?: boolean;
};

const tempCleanupEntries = new Map<string, TempCleanupEntry>();
let cleanupRegistered = false;

function pathStillMatchesReceipt(entry: TempCleanupEntry): boolean {
  if (!entry.identity) {
    return false;
  }
  try {
    const current = fsSync.lstatSync(entry.path, { bigint: true });
    return (!entry.singleLinkFile || (current.isFile() && current.nlink === 1n)) &&
      sameFileIdentityForCleanup(current, entry.identity);
  } catch (error) {
    return !entry.singleLinkFile && (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function cleanupRegisteredTempPathsSync(): void {
  for (const entry of tempCleanupEntries.values()) {
    try {
      if (pathStillMatchesReceipt(entry)) {
        removeRegisteredPathSync(entry);
      }
    } catch {
      // Process-exit cleanup is best-effort.
    }
  }
  tempCleanupEntries.clear();
}

function removeRegisteredPathSync(entry: TempCleanupEntry): void {
  if (entry.singleLinkFile) fsSync.unlinkSync(entry.path);
  else fsSync.rmSync(entry.path, { force: true, recursive: entry.recursive });
}

export function registerTempPathForExit(
  tempPath: string,
  options?: { recursive?: boolean; identity?: FileIdentityStat; singleLinkFile?: boolean },
): TempPathRegistration {
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", cleanupRegisteredTempPathsSync);
  }
  const entry: TempCleanupEntry = {
    path: tempPath,
    recursive: options?.recursive === true,
    identity: options?.identity,
    singleLinkFile: options?.singleLinkFile,
  };
  if (!entry.identity) {
    try {
      entry.identity = fsSync.lstatSync(tempPath, { bigint: true });
    } catch {
      // Callers that register before creation set the identity after opening.
    }
  }
  tempCleanupEntries.set(tempPath, entry);
  const unregister = (() => {
    tempCleanupEntries.delete(tempPath);
  }) as TempPathRegistration;
  unregister.setIdentity = (identity) => {
    entry.identity = identity;
  };
  return unregister;
}

export function __cleanupRegisteredTempPathsForTest(): void {
  cleanupRegisteredTempPathsSync();
}

export function __cleanupRegisteredTempPathForTest(tempPath: string): void {
  const entry = tempCleanupEntries.get(tempPath);
  if (!entry) {
    return;
  }
  try {
    if (pathStillMatchesReceipt(entry)) {
      removeRegisteredPathSync(entry);
    }
  } finally {
    tempCleanupEntries.delete(tempPath);
  }
}
