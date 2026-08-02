import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileStore } from "../src/file-store.js";
import { acquireFileLock } from "../src/file-lock.js";
import { configureFsSafeLocks, getFsSafeLockConfig } from "../src/lock-config.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";

const tempDirs: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  configureFsSafeLocks({
    retry: undefined,
    staleMs: undefined,
    staleRecovery: "fail-closed",
    timeoutMs: undefined,
  });
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("sidecar lock regressions", () => {
  it("does not delete a fresh sidecar lock during stale reclaim or old release", async () => {
    const base = await tempRoot("fs-safe-sidecar-token-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-test-${Date.now()}`);
    const held = await manager.acquire({
      targetPath,
      lockPath,
      staleMs: 1,
      payload: async () => ({ createdAt: "2000-01-01T00:00:00.000Z" }),
    });

    await fsp.writeFile(lockPath, JSON.stringify({ createdAt: new Date().toISOString() }));
    await held.release();
    await expect(fsp.readFile(lockPath, "utf8")).resolves.toContain("createdAt");

    let replaced = false;
    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        timeoutMs: 1,
        retry: { retries: 0 },
        payload: async () => ({ createdAt: new Date().toISOString() }),
        shouldReclaim: async () => {
          if (!replaced) {
            replaced = true;
            await fsp.writeFile(
              lockPath,
              JSON.stringify({ createdAt: "2999-01-01T00:00:00.000Z" }),
            );
            return true;
          }
          return false;
        },
      }),
    ).rejects.toMatchObject({ code: "file_lock_timeout" });
    await expect(fsp.readFile(lockPath, "utf8")).resolves.toContain("2999");
  });

  it("keeps internal sidecar lock identity out of user payloads", async () => {
    const base = await tempRoot("fs-safe-sidecar-payload-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-payload-test-${Date.now()}`);
    const lock = await manager.acquire({
      targetPath,
      lockPath,
      staleMs: 1,
      payload: async () => ({ createdAt: "2999-01-01T00:00:00.000Z", owner: "caller" }),
    });
    const raw = await fsp.readFile(lockPath, "utf8");
    expect(JSON.parse(raw)).toEqual({
      createdAt: "2999-01-01T00:00:00.000Z",
      owner: "caller",
    });
    await lock.release();

    const payloads: Array<Record<string, unknown> | null> = [];
    await fsp.writeFile(lockPath, raw, "utf8");
    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        timeoutMs: 1,
        retry: { retries: 0 },
        payload: async () => ({ createdAt: new Date().toISOString() }),
        shouldReclaim: async ({ payload }) => {
          payloads.push(payload);
          return false;
        },
      }),
    ).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(payloads).toEqual([{ createdAt: "2999-01-01T00:00:00.000Z", owner: "caller" }]);
  });

  it("retries when a contended sidecar disappears during stale detection", async () => {
    const base = await tempRoot("fs-safe-sidecar-vanish-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-vanish-test-${Date.now()}`);
    await fsp.writeFile(lockPath, JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));

    const lock = await manager.acquire({
      targetPath,
      lockPath,
      staleMs: 1,
      timeoutMs: 1_000,
      retry: { retries: 3, minTimeout: 1, maxTimeout: 1 },
      payload: async () => ({ createdAt: new Date().toISOString(), owner: "next" }),
      shouldReclaim: async () => {
        await fsp.rm(lockPath, { force: true });
        return true;
      },
    });
    try {
      await expect(fsp.readFile(lockPath, "utf8")).resolves.toContain("next");
    } finally {
      await lock.release();
    }
  });

  it("removes a stale sidecar only after caller approval under the reclaim guard", async () => {
    const base = await tempRoot("fs-safe-sidecar-remove-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-remove-test-${Date.now()}`);
    await fsp.writeFile(lockPath, JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));

    const seen: Array<Record<string, unknown> | null> = [];
    const lock = await manager.acquire({
      targetPath,
      lockPath,
      staleMs: 1,
      staleRecovery: "remove-if-unchanged",
      payload: async () => ({ createdAt: new Date().toISOString(), owner: "next" }),
      shouldReclaim: async () => true,
      shouldRemoveStaleLock: async (snapshot) => {
        expect(snapshot.lockPath).toBe(lockPath);
        expect(snapshot.raw).toContain("2000-01-01T00:00:00.000Z");
        seen.push(snapshot.payload);
        return true;
      },
    });
    try {
      expect(seen).toEqual([{ createdAt: "2000-01-01T00:00:00.000Z" }]);
      await expect(fsp.readFile(lockPath, "utf8")).resolves.toContain("next");
      await expect(fsp.stat(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await lock.release();
    }
  });

  it("fails closed when stale removal is not explicitly approved", async () => {
    const base = await tempRoot("fs-safe-sidecar-refuse-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-refuse-test-${Date.now()}`);
    await fsp.writeFile(lockPath, JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));

    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        retry: { retries: 0 },
        staleRecovery: "remove-if-unchanged",
        payload: async () => ({ createdAt: new Date().toISOString() }),
        shouldReclaim: async () => true,
      }),
    ).rejects.toMatchObject({ code: "file_lock_stale" });
    await expect(fsp.readFile(lockPath, "utf8")).resolves.toContain("2000");
    await expect(fsp.stat(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes stale reclaimers so a replacement lock cannot be deleted", async () => {
    const base = await tempRoot("fs-safe-sidecar-reclaim-guard-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    await fsp.writeFile(lockPath, JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));

    let approveFirst!: () => void;
    const firstApproval = new Promise<void>((resolve) => {
      approveFirst = resolve;
    });
    let firstEnteredApproval!: () => void;
    const firstApprovalEntered = new Promise<void>((resolve) => {
      firstEnteredApproval = resolve;
    });
    const firstManager = createSidecarLockManager(`fs-safe-first-reclaimer-${Date.now()}`);
    const secondManager = createSidecarLockManager(`fs-safe-second-reclaimer-${Date.now()}`);
    const secondRemoval = vi.fn(async () => true);

    const firstAcquire = firstManager.acquire({
      targetPath,
      lockPath,
      staleMs: 1,
      staleRecovery: "remove-if-unchanged",
      payload: async () => ({ createdAt: "2999-01-01T00:00:00.000Z", owner: "first" }),
      shouldReclaim: async ({ payload }) => payload?.createdAt === "2000-01-01T00:00:00.000Z",
      shouldRemoveStaleLock: async () => {
        firstEnteredApproval();
        await firstApproval;
        return true;
      },
    });
    await firstApprovalEntered;

    const secondAcquire = secondManager.acquire({
      targetPath,
      lockPath,
      staleMs: 1,
      timeoutMs: 50,
      retry: { retries: 20, minTimeout: 1, maxTimeout: 2 },
      staleRecovery: "remove-if-unchanged",
      payload: async () => ({ createdAt: new Date().toISOString(), owner: "second" }),
      shouldReclaim: async ({ payload }) => payload?.createdAt === "2000-01-01T00:00:00.000Z",
      shouldRemoveStaleLock: secondRemoval,
    });
    const secondAcquireResult = expect(secondAcquire).rejects.toMatchObject({ code: "file_lock_timeout" });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondRemoval).not.toHaveBeenCalled();
    approveFirst();
    const firstLock = await firstAcquire;
    await secondAcquireResult;
    expect(secondRemoval).not.toHaveBeenCalled();
    await expect(fsp.readFile(lockPath, "utf8")).resolves.toContain("first");
    await firstLock.release();
  });

  it("fails closed when a crashed reclaimer leaves its guard behind", async () => {
    const base = await tempRoot("fs-safe-sidecar-reclaim-guard-stale-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const reclaimGuardPath = `${lockPath}.reclaim`;
    await fsp.mkdir(reclaimGuardPath);

    const manager = createSidecarLockManager(`fs-safe-stale-reclaim-guard-${Date.now()}`);
    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        timeoutMs: 5,
        retry: { retries: 1, minTimeout: 1, maxTimeout: 1 },
        staleRecovery: "remove-if-unchanged",
        payload: async () => ({ createdAt: new Date().toISOString() }),
        shouldReclaim: async () => true,
        shouldRemoveStaleLock: async () => true,
      }),
    ).rejects.toMatchObject({ code: "file_lock_timeout" });
    expect((await fsp.stat(reclaimGuardPath)).isDirectory()).toBe(true);
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("backfills reclaim state created by an older package copy", async () => {
    const base = await tempRoot("fs-safe-sidecar-legacy-manager-state-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    await fsp.writeFile(lockPath, JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));

    const managerKey = `fs-safe-legacy-manager-state-${Date.now()}`;
    const managers = Reflect.get(globalThis, Symbol.for("fsSafe.sidecarLockManagers")) as Map<
      string,
      { cleanupRegistered: boolean; held: Map<string, unknown> }
    >;
    managers.set(managerKey, { cleanupRegistered: true, held: new Map() });

    const manager = createSidecarLockManager(managerKey);
    const lock = await manager.acquire({
      targetPath,
      lockPath,
      staleMs: 1,
      staleRecovery: "remove-if-unchanged",
      payload: async () => ({ createdAt: new Date().toISOString(), owner: "next" }),
      shouldReclaim: async () => true,
      shouldRemoveStaleLock: async () => true,
    });
    await lock.release();
    managers.delete(managerKey);
    await expect(fsp.stat(`${lockPath}.reclaim`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans failed sidecar locks and preserves stale corrupt locks", async () => {
    const base = await tempRoot("fs-safe-sidecar-corrupt-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-corrupt-test-${Date.now()}`);

    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        payload: async () => {
          throw new Error("payload failed");
        },
      }),
    ).rejects.toThrow("payload failed");
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    await fsp.writeFile(lockPath, "{", "utf8");
    await fsp.utimes(lockPath, new Date(0), new Date(0));
    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        timeoutMs: 1,
        retry: { retries: 0 },
        payload: async () => ({ createdAt: new Date().toISOString() }),
      }),
    ).rejects.toMatchObject({ code: "file_lock_stale" });
    await expect(fsp.readFile(lockPath, "utf8")).resolves.toBe("{");
  });

  it("fails closed when an existing sidecar cannot be read", async () => {
    const base = await tempRoot("fs-safe-sidecar-unreadable-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-unreadable-test-${Date.now()}`);
    await fsp.writeFile(lockPath, JSON.stringify({ createdAt: "2000-01-01T00:00:00.000Z" }));
    const realReadFile = fsp.readFile.bind(fsp);
    vi.spyOn(fsp, "readFile").mockImplementation(async (...args) => {
      if (String(args[0]) === lockPath) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return await realReadFile(...args);
    });

    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        timeoutMs: 1,
        retry: { retries: 0 },
        payload: async () => ({ createdAt: new Date().toISOString() }),
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("keeps lock config as explicit defaults, not global auto-locking", async () => {
    const base = await tempRoot("fs-safe-lock-config-");
    const statePath = path.join(base, "state.json");
    configureFsSafeLocks({ staleMs: 1, timeoutMs: 1, retry: { retries: 0 } });

    const unlocked = fileStore({ rootDir: base }).json<{ count: number }>("state.json");
    await unlocked.write({ count: 1 });
    await expect(fsp.stat(`${statePath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });

    const config = getFsSafeLockConfig();
    expect(config.staleRecovery).toBe("fail-closed");
    expect(config.timeoutMs).toBe(1);

    const lock = await acquireFileLock(path.join(base, "direct.json"), {
      payload: async () => ({ owner: "direct" }),
    });
    await lock.release();
  });
});
