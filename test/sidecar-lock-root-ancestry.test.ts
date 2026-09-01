import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { readSidecarLockSnapshot } from "../src/sidecar-lock-reclaim.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

it.skipIf(process.platform === "win32")("rechecks ancestors even when the immediate parent inode is preserved", async () => {
  const capability = await root(await tempRoot("sidecar-ancestor-swap-"));
  const relative = "ancestor/parent/state.lock", lockPath = path.join(capability.rootReal, relative);
  await capability.create(relative, "{}");
  __setFsSafeTestHooksForTest({ async afterOpenedPathIdentityCheck(candidate) {
    if (candidate !== lockPath) return;
    __setFsSafeTestHooksForTest();
    await fs.unlink(lockPath);
    const ancestor = path.join(capability.rootReal, "ancestor");
    await fs.rename(ancestor, `${ancestor}.old`);
    await fs.mkdir(ancestor);
    await fs.rename(`${ancestor}.old/parent`, `${ancestor}/parent`);
  } });
  await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardUnlinked: true }))
    .rejects.toMatchObject({ code: "path-mismatch" });
});

it.skipIf(process.platform === "win32")("permits an unchanged canonical parent reached through an in-root symlink", async () => {
  const capability = await root(await tempRoot("sidecar-parent-alias-"), { symlinks: "follow-within-root" });
  await capability.mkdir("actual");
  await fs.symlink("actual", path.join(capability.rootReal, "alias"));
  const lockPath = path.join(capability.rootReal, "alias/state.lock");
  await capability.create("actual/state.lock", "{}");
  __setFsSafeTestHooksForTest({ async afterOpenedPathIdentityCheck(candidate) {
    if (candidate !== lockPath) return;
    __setFsSafeTestHooksForTest();
    await fs.unlink(lockPath);
  } });
  await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardUnlinked: true })).resolves.toBeNull();
  const manager = createFileLockManager(`alias:${lockPath}`);
  const held = await manager.acquire(path.join(capability.rootReal, "state"), {
    lockRoot: capability, lockPath, payload: () => ({}),
  });
  await expect(held.verifyStillHeld()).resolves.toBe(true);
  await held.release();
});

it.each(["numeric", "unknown", "changed", "EACCES", "EIO"])("rejects %s canonical directory reinspection", async (kind) => {
  const capability = await root(await tempRoot("sidecar-directory-evidence-"));
  const lockPath = path.join(capability.rootReal, "parent/state.lock"), parent = path.dirname(lockPath);
  await capability.create("parent/state.lock", "{}");
  __setFsSafeTestHooksForTest({ async afterOpenedPathIdentityCheck(candidate) {
    if (candidate !== lockPath) return;
    __setFsSafeTestHooksForTest();
    await fs.unlink(lockPath);
    Object.defineProperty(process, "platform", { value: "win32" });
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const value = await lstat(...args);
      if (String(args[0]) === parent && typeof args[1] === "object" && args[1]?.bigint) {
        if (kind === "EACCES" || kind === "EIO") throw Object.assign(new Error("directory failure"), { code: kind });
        Object.assign(value, { ino: kind === "numeric" ? Number(value.ino) : kind === "unknown" ? 0n : BigInt(value.ino) + 1n });
      }
      return value;
    });
  } });
  await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardUnlinked: true }))
    .rejects.toMatchObject({ code: "path-mismatch" });
});

it.each(["EACCES", "EIO"])("does not treat initial directory %s as missing-parent evidence", async (code) => {
  const capability = await root(await tempRoot("sidecar-parent-denial-"));
  const lockPath = path.join(capability.rootReal, "state.lock");
  await capability.create("state.lock", "{}");
  const failure = Object.assign(new Error("directory failure"), { code });
  const lstat = fs.lstat.bind(fs), open = vi.spyOn(capability, "open");
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if (String(args[0]) === capability.rootReal && typeof args[1] === "object" && args[1]?.bigint) throw failure;
    return await lstat(...args);
  });
  await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardUnlinked: true })).rejects.toBe(failure);
  expect(open).not.toHaveBeenCalled();
});

it("creates missing parents without inventing an earlier directory receipt", async () => {
  const capability = await root(await tempRoot("sidecar-missing-parent-"));
  const target = path.join(capability.rootReal, "state"), lockPath = path.join(capability.rootReal, "new/parent/state.lock");
  const manager = createFileLockManager(`missing:${target}`);
  const held = await manager.acquire(target, { lockRoot: capability, lockPath, payload: () => ({}) });
  await expect(held.verifyStillHeld()).resolves.toBe(true);
  await held.release();
});
