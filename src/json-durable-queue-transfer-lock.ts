import { randomUUID } from "node:crypto";
import path from "node:path";
import { sha256Hex } from "./file-identity.js";
import { withSidecarLock } from "./sidecar-lock.js";

export async function withQueueTransferLock<T>(
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(
    path.dirname(filePath),
    `.fs-safe-transfer-${sha256Hex(path.basename(filePath)).slice(0, 32)}.lock`,
  );
  return await withSidecarLock(
    filePath,
    {
      managerKey: "fs-safe.queue-transfer",
      lockPath,
      staleMs: 30_000,
      staleRecovery: "fail-closed",
      timeoutMs: 45_000,
      payload: () => ({
        ownerToken: randomUUID(),
        createdAt: new Date().toISOString(),
      }),
      retry: { retries: 180, minTimeout: 25, maxTimeout: 250, factor: 1.1 },
    },
    run,
  );
}
