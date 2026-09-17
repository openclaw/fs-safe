import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const syncHeldKey = Symbol.for("fsSafe.syncSidecarLocks");
const syncAdmissionsKey = Symbol.for("fsSafe.syncSidecarLockAdmissions");

type ManagerState = {
  held: Map<string, unknown>;
  admissions: Map<string, object>;
};

function asyncState(key: string): ManagerState {
  const managers = Reflect.get(globalThis, Symbol.for("fsSafe.sidecarLockManagers")) as Map<
    string,
    ManagerState
  >;
  return managers.get(key)!;
}

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  (Reflect.get(globalThis, syncHeldKey) as Map<string, unknown> | undefined)?.clear();
  (Reflect.get(globalThis, syncAdmissionsKey) as Map<string, object> | undefined)?.clear();
});

describe("sidecar-lock admission publication rollback", () => {
  it("preserves a foreign synchronous owner inserted before conditional publication", async () => {
    const directory = await tempRoot("fs-safe-sync-admission-publication-");
    const target = path.join(directory, "state.json");
    const lockPath = path.join(directory, "candidate.lock");
    const foreign = { handle: {}, owner: "foreign" };
    let held!: Map<string, unknown>;

    expect(() => acquireFileLockSync(target, {
      lockPath,
      timeoutMs: 0,
      retry: { retries: 0 },
      payload: () => {
        held = Reflect.get(globalThis, syncHeldKey) as Map<string, unknown>;
        held.set(target, foreign);
        return { owner: "candidate" };
      },
    })).toThrow(expect.objectContaining({ code: "file_lock_timeout", lockPath }));
    expect(held.get(target)).toBe(foreign);
    expect((Reflect.get(globalThis, syncAdmissionsKey) as Map<string, object>).size).toBe(0);
    expect(fsSync.existsSync(lockPath)).toBe(false);
    held.clear();
  });

  it("preserves a foreign async owner inserted before conditional publication", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-async-admission-publication-");
    const target = path.join(directory, "state.json");
    const lockPath = path.join(directory, "candidate.lock");
    const key = `admission-publication:${directory}`;
    const manager = createSidecarLockManager(key);
    const state = asyncState(key);
    const foreign = { handle: {}, owner: "foreign" };

    try {
      await expect(manager.acquire({
        targetPath: target,
        staleMs: 30_000,
        lockPath,
        timeoutMs: 0,
        retry: { retries: 0 },
        payload: async () => {
          state.held.set(target, foreign);
          return { owner: "candidate" };
        },
      })).rejects.toMatchObject({ code: "file_lock_timeout", lockPath });
      expect(state.held.get(target)).toBe(foreign);
      expect(state.admissions.size).toBe(0);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      state.held.clear();
      state.admissions.clear();
    }
  });
});
