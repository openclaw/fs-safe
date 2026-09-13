import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import {
  acquireFileLockSync,
  createFileLockManager,
} from "../src/file-lock.js";
import { itPosix, itWin32, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const aliasError = {
  code: "invalid-path",
  details: { reason: "windows-path-alias" },
};
const payload = () => ({ pid: process.pid, createdAt: new Date().toISOString() });

itWin32("rejects async target and explicit lock aliases before creating directories", async () => {
  const base = await tempRoot("fs-safe-ads-lock-async-");
  const manager = createFileLockManager(`ads-async-${base}`);
  const targetParent = path.join(base, "target-parent");
  const targetPayload = vi.fn(payload);
  await expect(manager.acquire(`${path.join(targetParent, "state.json")}:hidden`, {
    payload: targetPayload,
  })).rejects.toMatchObject(aliasError);
  expect(targetPayload).not.toHaveBeenCalled();
  await expect(fs.stat(targetParent)).rejects.toMatchObject({ code: "ENOENT" });

  const explicitTargetParent = path.join(base, "explicit-target-parent");
  const lockParent = path.join(base, "lock-parent");
  const lockPayload = vi.fn(payload);
  await expect(manager.acquire(path.join(explicitTargetParent, "state.json"), {
    lockPath: `${path.join(lockParent, "state.lock")}:hidden`,
    payload: lockPayload,
  })).rejects.toMatchObject(aliasError);
  expect(lockPayload).not.toHaveBeenCalled();
  await expect(fs.stat(explicitTargetParent)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(lockParent)).rejects.toMatchObject({ code: "ENOENT" });
});

itWin32("retains inherited lockPath admission through manager wrappers", async () => {
  const base = await tempRoot("fs-safe-ads-lock-inherited-");
  const target = path.join(base, "state.json");
  const alias = `${path.join(base, "state.lock")}:hidden`;
  const manager = createFileLockManager(`ads-inherited-${base}`);
  for (const route of ["acquire", "withLock"] as const) {
    let reads = 0;
    const prototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(prototype, "lockPath", {
      get() {
        reads += 1;
        return alias;
      },
    });
    const options = Object.assign(Object.create(prototype), { payload }) as {
      lockPath: string;
      payload: typeof payload;
    };
    const run = vi.fn(async () => undefined);
    const operation = route === "acquire"
      ? manager.acquire(target, options)
      : manager.withLock(target, options, run);
    await expect(operation).rejects.toMatchObject(aliasError);
    expect(reads).toBe(1);
    expect(run).not.toHaveBeenCalled();
  }
  await expect(fs.readdir(base)).resolves.toEqual([]);
});

itWin32("rejects sync target and explicit lock aliases before creating directories", async () => {
  const base = await tempRoot("fs-safe-ads-lock-sync-");
  const targetParent = path.join(base, "target-parent");
  const targetPayload = vi.fn(payload);
  expect(() => acquireFileLockSync(`${path.join(targetParent, "state.json")}:hidden`, {
    payload: targetPayload,
  })).toThrow(expect.objectContaining(aliasError));
  expect(targetPayload).not.toHaveBeenCalled();
  expect(fsSync.existsSync(targetParent)).toBe(false);

  const explicitTargetParent = path.join(base, "explicit-target-parent");
  const lockParent = path.join(base, "lock-parent");
  const lockPayload = vi.fn(payload);
  expect(() => acquireFileLockSync(path.join(explicitTargetParent, "state.json"), {
    lockPath: `${path.join(lockParent, "state.lock")}:hidden`,
    payload: lockPayload,
  })).toThrow(expect.objectContaining(aliasError));
  expect(lockPayload).not.toHaveBeenCalled();
  expect(fsSync.existsSync(explicitTargetParent)).toBe(false);
  expect(fsSync.existsSync(lockParent)).toBe(false);
});

itWin32("rejects invalid reentrant lock paths without retaining another reference", async () => {
  const base = await tempRoot("fs-safe-ads-lock-reentrant-");
  const target = path.join(base, "state.json");
  const manager = createFileLockManager(`ads-reentrant-${base}`);
  const first = await manager.acquire(target, { payload, reentrantOwner: "same-owner" });
  try {
    const secondPayload = vi.fn(payload);
    await expect(manager.acquire(target, {
      lockPath: `${first.lockPath}:hidden`,
      payload: secondPayload,
      reentrantOwner: "same-owner",
    })).rejects.toMatchObject(aliasError);
    expect(secondPayload).not.toHaveBeenCalled();
    expect(manager.heldEntries()).toHaveLength(1);
  } finally {
    await first.release();
  }
  await expect(fs.stat(first.lockPath)).rejects.toMatchObject({ code: "ENOENT" });

  const sync = acquireFileLockSync(target, { payload, reentrantOwner: "same-owner" });
  try {
    const secondPayload = vi.fn(payload);
    expect(() => acquireFileLockSync(target, {
      lockPath: `${sync.lockPath}:hidden`,
      payload: secondPayload,
      reentrantOwner: "same-owner",
    })).toThrow(expect.objectContaining(aliasError));
    expect(secondPayload).not.toHaveBeenCalled();
  } finally {
    sync.release();
  }
  expect(fsSync.existsSync(sync.lockPath)).toBe(false);
});

itWin32("rejects canonical target parents that resolve into an alternate namespace", async () => {
  const base = await tempRoot("fs-safe-ads-lock-canonical-");
  const target = path.join(base, "state.json");
  const manager = createFileLockManager(`ads-canonical-${base}`);
  const native = vi.spyOn(fsSync.realpathSync, "native");
  try {
    native.mockReturnValue(`${base}:hidden`);
    await expect(manager.acquire(target, { payload })).rejects.toMatchObject(aliasError);
    expect(() => acquireFileLockSync(target, { payload }))
      .toThrow(expect.objectContaining(aliasError));
  } finally {
    native.mockRestore();
  }
  await expect(fs.readdir(base)).resolves.toEqual([]);
});

itPosix("preserves colon-bearing target and explicit lock names", async () => {
  const base = await tempRoot("fs-safe-colon-lock-");
  const target = path.join(base, "state:primary.json");
  const lockPath = path.join(base, "state:guard.lock");
  const manager = createFileLockManager(`colon-${base}`);
  const lock = await manager.acquire(target, { lockPath, payload });
  expect(lock.lockPath).toBe(lockPath);
  await lock.release();

  const sync = acquireFileLockSync(target, { lockPath, payload });
  expect(sync.lockPath).toBe(lockPath);
  sync.release();
  await expect(fs.readdir(base)).resolves.toEqual([]);
});
