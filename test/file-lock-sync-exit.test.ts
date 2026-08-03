import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import { acquireFileLockSync } from "../src/file-lock.js";

const { tempRoot } = useTempDirs();

describe("synchronous file-lock process-exit cleanup", () => {
  it.each([false, true])(
    "registers identity-checked cleanup (replacement=%s)",
    async (replaceLock) => {
      const base = await tempRoot("fs-safe-sync-lock-exit-");
      const targetPath = path.join(base, "state.json");
      const lock = acquireFileLockSync(targetPath, {
        staleMs: 60_000,
        payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
      });
      expect(fs.existsSync(lock.lockPath)).toBe(true);
      if (replaceLock) {
        fs.renameSync(lock.lockPath, `${lock.lockPath}.displaced`);
        fs.writeFileSync(lock.lockPath, "replacement");
      }

      const cleanup = Reflect.get(
        globalThis,
        Symbol.for("fsSafe.syncSidecarLockCleanupHandler"),
      ) as () => void;
      expect(cleanup).toBeTypeOf("function");
      cleanup();

      if (replaceLock) {
        expect(fs.readFileSync(lock.lockPath, "utf8")).toBe("replacement");
      } else {
        expect(fs.existsSync(lock.lockPath)).toBe(false);
      }
    },
  );
});
