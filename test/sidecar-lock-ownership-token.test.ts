import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  readSidecarLockOwnershipToken,
  readSidecarLockSnapshot,
  serializeSidecarLockPayload,
  sidecarLockSnapshotMatches,
} from "../src/sidecar-lock-reclaim.js";

const { tempRoot } = useTempDirs();


afterEach(async () => {
  configureFsSafeNative({ mode: "auto" });
  vi.restoreAllMocks();
});

describe("sidecar lock ownership tokens", () => {
  it("round-trips a token without changing the parsed payload", async () => {
    const base = await tempRoot("fs-safe-sidecar-token-round-trip-");
    const lockPath = path.join(base, "state.json.lock");
    const payload = { createdAt: "2999-01-01T00:00:00.000Z", owner: "caller" };
    const serialized = serializeSidecarLockPayload(payload);

    expect(serialized.ownershipToken).toMatch(/^[ \t]+$/);
    expect(readSidecarLockOwnershipToken(serialized.raw)).toBe(serialized.ownershipToken);
    expect(JSON.parse(serialized.raw)).toEqual(payload);

    await fsp.writeFile(lockPath, serialized.raw, "utf8");
    const snapshot = await readSidecarLockSnapshot(lockPath);
    expect(snapshot?.raw).toBe(serialized.raw);
    expect(snapshot?.payload).toEqual(payload);
    expect(snapshot?.ownershipToken).toBeUndefined();
    expect(readSidecarLockOwnershipToken(`${JSON.stringify(payload)}\n`)).toBeUndefined();
  });

  it("releases its sidecar when descriptor and pathname identity drift", async () => {
    const base = await tempRoot("fs-safe-sidecar-identity-drift-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-identity-drift-${Date.now()}`);
    const lock = await manager.acquire({
      targetPath,
      lockPath,
      staleMs: 1,
      payload: async () => ({ createdAt: new Date().toISOString(), owner: "caller" }),
    });
    const realLstat = fsp.lstat.bind(fsp);
    vi.spyOn(fsp, "lstat").mockImplementation(async (...args) => {
      const stat = await realLstat(...args);
      if (String(args[0]) !== lockPath) {
        return stat;
      }
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        ino: typeof stat.ino === "bigint" ? stat.ino + 1n : stat.ino + 1,
      });
    });

    await lock.release();

    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases its sidecar from process-exit cleanup when identity drifts", async () => {
    const base = await tempRoot("fs-safe-sidecar-sync-identity-drift-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-sync-identity-drift-${Date.now()}`);
    let exitListener: (() => void) | undefined;

    try {
      await manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        payload: async () => ({ createdAt: new Date().toISOString(), owner: "caller" }),
      });
      const realLstatSync = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = realLstatSync(...args);
        if (String(args[0]) !== lockPath) {
          return stat;
        }
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
          ino: typeof stat.ino === "bigint" ? stat.ino + 1n : stat.ino + 1,
        });
      });

      exitListener = Reflect.get(
        globalThis,
        Symbol.for("fsSafe.sidecarLockCleanupHandler"),
      ) as (() => void) | undefined;
      expect(exitListener).toBeDefined();
      exitListener?.();

      expect(fsSync.existsSync(lockPath)).toBe(false);
    } finally {
      manager.reset();
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects non-regular exit-time replacements before reading them",
    async () => {
      const base = await tempRoot("fs-safe-sync-non-regular-replacement-");
      const targetPath = path.join(base, "state.json");
      const lockPath = `${targetPath}.lock`;
      const replacementPath = path.join(base, "replacement.lock");
      const manager = createSidecarLockManager(`fs-safe-sync-non-regular-${Date.now()}`);
      let exitListener: (() => void) | undefined;

      try {
        await manager.acquire({
          targetPath,
          lockPath,
          staleMs: 1,
          payload: async () => ({ createdAt: new Date().toISOString(), owner: "caller" }),
        });
        const raw = await fsp.readFile(lockPath, "utf8");
        await fsp.rm(lockPath);
        await fsp.writeFile(replacementPath, raw, "utf8");
        await fsp.symlink(replacementPath, lockPath);
        const readFileSync = vi.spyOn(fsSync, "readFileSync");

        exitListener = Reflect.get(
          globalThis,
          Symbol.for("fsSafe.sidecarLockCleanupHandler"),
        ) as (() => void) | undefined;
        expect(exitListener).toBeDefined();
        exitListener?.();

        expect(readFileSync).not.toHaveBeenCalledWith(lockPath, "utf8");
        expect((await fsp.lstat(lockPath)).isSymbolicLink()).toBe(true);
      } finally {
        manager.reset();
      }
    },
  );

  it("does not delete a replacement lock with the same caller payload", async () => {
    const base = await tempRoot("fs-safe-sidecar-same-payload-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const payload = { createdAt: "2999-01-01T00:00:00.000Z", owner: "caller" };
    const firstManager = createSidecarLockManager(`fs-safe-same-payload-first-${Date.now()}`);
    const secondManager = createSidecarLockManager(`fs-safe-same-payload-second-${Date.now()}`);
    const first = await firstManager.acquire({
      targetPath,
      lockPath,
      staleMs: 1,
      payload: async () => payload,
    });
    const firstRaw = await fsp.readFile(lockPath, "utf8");
    await fsp.rm(lockPath);
    const second = await secondManager.acquire({
      targetPath,
      lockPath,
      staleMs: 1,
      payload: async () => payload,
    });
    const secondRaw = await fsp.readFile(lockPath, "utf8");

    expect(JSON.parse(firstRaw)).toEqual(payload);
    expect(JSON.parse(secondRaw)).toEqual(payload);
    expect(secondRaw).not.toBe(firstRaw);
    await first.release();
    await expect(fsp.readFile(lockPath, "utf8")).resolves.toBe(secondRaw);
    await second.release();
  });

  it("keeps a sidecar whose internal ownership token was trimmed", async () => {
    const base = await tempRoot("fs-safe-sidecar-trimmed-token-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-trimmed-token-${Date.now()}`);
    const lock = await manager.acquire({
      targetPath,
      lockPath,
      staleMs: 1,
      payload: async () => ({ createdAt: new Date().toISOString(), owner: "caller" }),
    });
    const raw = await fsp.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    await fsp.writeFile(lockPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    await lock.release();

    await expect(fsp.readFile(lockPath, "utf8")).resolves.toBe(
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
  });

  it.skipIf(process.platform === "win32")(
    "keeps a symlink replacement even when its target contains the owned bytes",
    async () => {
      const base = await tempRoot("fs-safe-sidecar-symlink-replacement-");
      const targetPath = path.join(base, "state.json");
      const lockPath = `${targetPath}.lock`;
      const replacementPath = path.join(base, "replacement.lock");
      const manager = createSidecarLockManager(`fs-safe-symlink-replacement-${Date.now()}`);
      const lock = await manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        payload: async () => ({ createdAt: new Date().toISOString(), owner: "caller" }),
      });
      const raw = await fsp.readFile(lockPath, "utf8");
      await fsp.rm(lockPath);
      await fsp.writeFile(replacementPath, raw, "utf8");
      await fsp.symlink(replacementPath, lockPath);

      await lock.release();

      expect((await fsp.lstat(lockPath)).isSymbolicLink()).toBe(true);
      await expect(fsp.readFile(replacementPath, "utf8")).resolves.toBe(raw);
    },
  );

  it("retains identity and content checks for legacy snapshots", async () => {
    const base = await tempRoot("fs-safe-sidecar-legacy-identity-");
    const lockPath = path.join(base, "state.json.lock");
    const raw = '{"owner":"legacy"}\n';
    await fsp.writeFile(lockPath, raw, "utf8");
    const stat = await fsp.lstat(lockPath);
    const driftedStat = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      // Windows file indexes can be above Number.MAX_SAFE_INTEGER; use a visible delta.
      ino: typeof stat.ino === "bigint" ? stat.ino + 1024n : stat.ino + 1024,
    });

    expect(
      sidecarLockSnapshotMatches(
        { raw, payload: { owner: "legacy" }, stat },
        { raw, payload: { owner: "legacy" }, stat },
      ),
    ).toBe(true);
    expect(
      sidecarLockSnapshotMatches(
        { raw, payload: { owner: "legacy" }, stat: driftedStat },
        { raw, payload: { owner: "legacy" }, stat },
      ),
    ).toBe(false);
    expect(
      sidecarLockSnapshotMatches(
        { raw: '{"owner":"replacement"}\n', payload: { owner: "replacement" }, stat },
        { raw, payload: { owner: "legacy" }, stat },
      ),
    ).toBe(false);
  });

  it("treats malformed JSON and a partial token as unowned disk snapshots", async () => {
    const base = await tempRoot("fs-safe-sidecar-malformed-");
    const lockPath = path.join(base, "state.json.lock");
    await fsp.writeFile(lockPath, "{", "utf8");

    const malformedSnapshot = await readSidecarLockSnapshot(lockPath);
    expect(malformedSnapshot?.raw).toBe("{");
    expect(malformedSnapshot?.payload).toBeNull();
    expect(readSidecarLockOwnershipToken("{")).toBeUndefined();

    const payload = { owner: "caller" };
    const serialized = serializeSidecarLockPayload(payload);
    const partialRaw = serialized.raw.slice(0, -2);
    await fsp.writeFile(lockPath, partialRaw, "utf8");
    const partialSnapshot = await readSidecarLockSnapshot(lockPath);
    expect(partialSnapshot?.payload).toEqual(payload);
    expect(readSidecarLockOwnershipToken(partialRaw)).toBeUndefined();
  });

  it("cleans a partial sidecar left by a failed write", async () => {
    configureFsSafeNative({ mode: "off" });
    const base = await tempRoot("fs-safe-sidecar-partial-write-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    const manager = createSidecarLockManager(`fs-safe-partial-write-${Date.now()}`);
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const originalWriteFile = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async (data) => {
        const raw = typeof data === "string" ? data : Buffer.from(data).toString();
        await originalWriteFile(raw.slice(0, 4), "utf8");
        throw Object.assign(new Error("partial write"), { code: "EIO" });
      });
      return handle;
    });

    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        payload: async () => ({ createdAt: new Date().toISOString(), owner: "caller" }),
      }),
    ).rejects.toMatchObject({ code: "EIO" });
    await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
