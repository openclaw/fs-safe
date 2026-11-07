import type { FileStoreWriteOptions } from "./file-store.js";

export function snapshotWriteOptions(
  options?: FileStoreWriteOptions,
  durabilityFirst = true,
): FileStoreWriteOptions | undefined {
  if (options == null) return undefined;
  return durabilityFirst ? {
    maxBytes: options.maxBytes,
    allowDrvfsRenameRecovery: options.allowDrvfsRenameRecovery,
    durable: options.durable,
    dirMode: options.dirMode,
    mode: options.mode,
  } : {
    maxBytes: options.maxBytes,
    allowDrvfsRenameRecovery: options.allowDrvfsRenameRecovery,
    dirMode: options.dirMode,
    mode: options.mode,
    durable: options.durable,
  };
}
