import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { readSidecarLockSnapshot } from "../src/sidecar-lock-reclaim.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const itPosix = it.skipIf(process.platform === "win32");
afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

itPosix.each(["root", "strict", "unlinked", "changed"] as const)(
  "keeps pre-open replacement separate from %s read authority", async (policy) => {
    const capability = await root(await tempRoot("sidecar-preopen-policy-"));
    const lockPath = path.join(capability.rootReal, "state.lock");
    await capability.create("state.lock", '{"owner":"original"}');
    let descriptor: FileHandle | undefined;
    __setFsSafeTestHooksForTest({ async afterPreOpenLstat(candidate) {
      if (candidate !== lockPath) return;
      __setFsSafeTestHooksForTest();
      await fs.rename(lockPath, `${lockPath}.old`);
      await fs.writeFile(lockPath, '{"owner":"replacement"}', { flag: "wx" });
    }, afterOpen(candidate, handle) {
      if (candidate === lockPath) descriptor = handle;
    } });
    const parsePayload = vi.fn(JSON.parse);
    const pending = policy === "root" ? capability.open("state.lock") : readSidecarLockSnapshot(lockPath, {
      lockRoot: capability, parsePayload, discardObservation: policy === "strict" ? undefined : policy,
    });
    if (policy === "changed") await expect(pending).resolves.toBeNull();
    else await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
    expect(descriptor?.fd).toBe(-1);
    expect(parsePayload).not.toHaveBeenCalled();
    expect(await fs.readFile(lockPath, "utf8")).toBe('{"owner":"replacement"}');
    expect(await fs.readFile(`${lockPath}.old`, "utf8")).toBe('{"owner":"original"}');
    expect((await fs.lstat(`${lockPath}.old`)).nlink).toBe(1);
  },
);

itPosix.each(["root", "ancestor", "symlink-leaf", "directory-leaf", "before-multilink", "opened-multilink", "numeric-multilink"])(
  "rejects a changed snapshot with %s evidence", async (mutation) => {
    const base = await tempRoot("sidecar-preopen-boundary-");
    const rootDir = path.join(base, "root"), relative = "ancestor/parent/state.lock";
    await fs.mkdir(rootDir);
    const capability = await root(rootDir);
    const lockPath = path.join(capability.rootReal, relative), outside = path.join(base, "outside");
    await fs.writeFile(outside, "sentinel");
    await capability.create(relative, '{"owner":"original"}', { mkdir: true });
    if (mutation === "before-multilink") await fs.link(lockPath, path.join(base, "original-alias"));
    let descriptor: FileHandle | undefined;
    __setFsSafeTestHooksForTest({ async afterPreOpenLstat(candidate) {
      if (candidate !== lockPath) return;
      __setFsSafeTestHooksForTest();
      if (mutation === "root") {
        await fs.rename(rootDir, path.join(base, "old-root"));
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
      } else {
        if (mutation === "ancestor") {
          const ancestor = path.join(rootDir, "ancestor");
          await fs.rename(ancestor, path.join(base, "old-ancestor"));
          await fs.mkdir(ancestor);
          await fs.rename(path.join(base, "old-ancestor/parent"), path.join(ancestor, "parent"));
        }
        await fs.rename(lockPath, `${lockPath}.old`);
      }
      await fs.writeFile(lockPath, '{"owner":"replacement"}', { flag: "wx" });
      if (mutation === "opened-multilink") await fs.link(lockPath, path.join(base, "replacement-alias"));
    }, async afterOpen(candidate, handle) {
      if (candidate !== lockPath) return;
      descriptor = handle;
      if (mutation === "numeric-multilink") {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (options) => {
          const value = await stat(options);
          return options?.bigint ? value : Object.assign(value, { nlink: 2 });
        });
      }
      if (mutation === "symlink-leaf" || mutation === "directory-leaf") {
        await fs.unlink(lockPath);
        if (mutation === "symlink-leaf") await fs.symlink(outside, lockPath);
        else await fs.mkdir(lockPath);
      }
    } });
    const parsePayload = vi.fn(JSON.parse);
    await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardObservation: "changed", parsePayload }))
      .rejects.toMatchObject({ code: "path-mismatch" });
    expect(descriptor?.fd).toBe(-1);
    expect(parsePayload).not.toHaveBeenCalled();
    expect(await fs.readFile(outside, "utf8")).toBe("sentinel");
    if (!mutation.endsWith("-leaf")) expect(await fs.readFile(lockPath, "utf8")).toBe('{"owner":"replacement"}');
  },
);

itPosix("does not discard a pre-open replacement during creator admission", async () => {
  const capability = await root(await tempRoot("sidecar-preopen-admission-"));
  const target = path.join(capability.rootReal, "state"), lockPath = `${target}.lock`;
  const manager = createFileLockManager(`preopen-admission:${target}`), create = vi.spyOn(capability, "create");
  __setFsSafeTestHooksForTest({ async afterPreOpenLstat(candidate) {
    if (candidate !== lockPath) return;
    __setFsSafeTestHooksForTest();
    await fs.rename(lockPath, `${lockPath}.old`);
    await fs.writeFile(lockPath, '{"owner":"replacement"}', { flag: "wx" });
  } });
  await expect(manager.acquire(target, { lockRoot: capability, payload: () => ({ owner: "creator" }), retry: { retries: 0 } }))
    .rejects.toMatchObject({ code: "path-mismatch" });
  expect(create).toHaveBeenCalledTimes(1);
  expect(manager.heldEntries()).toEqual([]);
  await manager.drain();
  expect(JSON.parse(await fs.readFile(`${lockPath}.old`, "utf8"))).toEqual({ owner: "creator" });
  expect(await fs.readFile(lockPath, "utf8")).toBe('{"owner":"replacement"}');
});

itPosix("charges a changed observation to the retry budget without parsing or reclaiming", async () => {
  const capability = await root(await tempRoot("sidecar-preopen-budget-"));
  const target = path.join(capability.rootReal, "state"), lockPath = `${target}.lock`;
  await capability.create("state.lock", '{"owner":"original"}');
  const manager = createFileLockManager(`preopen-budget:${target}`);
  const create = vi.spyOn(capability, "create"), parsePayload = vi.fn(JSON.parse), shouldReclaim = vi.fn(() => true);
  __setFsSafeTestHooksForTest({ async afterPreOpenLstat(candidate) {
    if (candidate !== lockPath) return;
    __setFsSafeTestHooksForTest();
    await fs.rename(lockPath, `${lockPath}.old`);
    await fs.writeFile(lockPath, '{"owner":"replacement"}', { flag: "wx" });
  } });
  await expect(manager.acquire(target, {
    lockRoot: capability, payload: () => ({}), retry: { retries: 0 }, parsePayload, shouldReclaim,
  })).rejects.toMatchObject({ code: "file_lock_timeout" });
  expect(create).toHaveBeenCalledTimes(1);
  expect(parsePayload).not.toHaveBeenCalled();
  expect(shouldReclaim).not.toHaveBeenCalled();
  expect(manager.heldEntries()).toEqual([]);
  await manager.drain();
  expect(await fs.readFile(lockPath, "utf8")).toBe('{"owner":"replacement"}');
});
