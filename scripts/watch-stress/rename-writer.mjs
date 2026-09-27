import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// External-writer policy only. Windows pins ancestor names while a consumer
// holds a descendant file open, including ordinary delete-sharing reads.
export function createRenameWriter({ platform = process.platform, rename = fs.rename, wait = delay } = {}) {
  const metrics = { renameRetries: 0, renameExhaustedRetries: 0 };
  return {
    metrics,
    async rename(from, to) {
      for (let attempt = 0; ; attempt++) {
        try { return await rename(from, to); }
        catch (error) {
          if (platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
          if (attempt === 9) { metrics.renameExhaustedRetries++; throw error; }
          metrics.renameRetries++;
          await wait(Math.min(5 * 2 ** attempt, 100));
        }
      }
    },
  };
}

// Each stress scenario runs in its own process, including the soak GC child.
export const renameWriter = createRenameWriter();
