import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { readSidecarLockSnapshot } from "../src/sidecar-lock-reclaim.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});
const posix = it.skipIf(process.platform === "win32");

function mutateOpened(lockPath: string, mutate: (handle: FileHandle) => Promise<void>, afterIdentity = true) {
  let opened: FileHandle | undefined;
  const hook = async (candidate: string, handle: FileHandle) => {
    if (candidate !== lockPath || opened) return;
    opened = handle;
    __setFsSafeTestHooksForTest();
    await mutate(handle);
  };
  __setFsSafeTestHooksForTest(afterIdentity
    ? { afterOpenedPathIdentityCheck: hook } : { afterOpen: hook });
  return () => opened;
}

posix.each(["unlink", "replacement"])("post-create admission handles %s without admitting the lost record", async (mutation) => {
  const capability = await root(await tempRoot("sidecar-postcreate-"));
  const relative = "state.lock";
  const lockPath = path.join(capability.rootReal, relative);
  const target = path.join(capability.rootReal, "state");
  const manager = createFileLockManager(`postcreate:${target}`);
  const realOpen = capability.open.bind(capability);
  const create = vi.spyOn(capability, "create");
  let opened: (() => FileHandle | undefined) | undefined;
  const replacement = '{"owner":"replacement"}\n';
  vi.spyOn(capability, "open").mockImplementationOnce(async (...args) => {
    expect(create.mock.settledResults[0]?.type).toBe("fulfilled");
    opened = mutateOpened(lockPath, async (handle) => {
      if (mutation === "replacement") {
        await fs.rename(lockPath, `${lockPath}.displaced`);
        await fs.writeFile(lockPath, replacement, { flag: "wx" });
      } else {
        await fs.unlink(lockPath);
        expect((await handle.stat({ bigint: true })).nlink).toBe(0n);
      }
    }, mutation === "unlink");
    return await realOpen(...args);
  });
  const acquiring = manager.acquire(target, {
    lockRoot: capability, lockPath, payload: () => ({ owner: "new" }),
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
  });
  if (mutation === "replacement") {
    await expect(acquiring).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(replacement);
  } else {
    const held = await acquiring;
    try {
      expect(create).toHaveBeenCalledTimes(2);
      expect(create.mock.calls[0]?.[1]).not.toBe(create.mock.calls[1]?.[1]);
      await expect(held.verifyStillHeld()).resolves.toBe(true);
    } finally {
      await held.release();
    }
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(opened?.()?.fd).toBe(-1);
  expect(manager.heldEntries()).toEqual([]);
});

posix("generic Root.open remains strict after a direct test unlink", async () => {
  const capability = await root(await tempRoot("sidecar-generic-"));
  const lockPath = path.join(capability.rootReal, "file");
  await capability.create("file", "content");
  const opened = mutateOpened(lockPath, async (handle) => {
    await fs.unlink(lockPath);
    expect((await handle.stat({ bigint: true })).nlink).toBe(0n);
  });
  await expect(capability.open("file")).rejects.toMatchObject({ code: "path-mismatch" });
  expect(opened()?.fd).toBe(-1);
});

posix("post-create admission refuses a replacement installed before reopening", async () => {
  const capability = await root(await tempRoot("sidecar-before-reopen-"));
  const target = path.join(capability.rootReal, "state");
  const lockPath = `${target}.lock`;
  const manager = createFileLockManager(`before-reopen:${target}`);
  const realOpen = capability.open.bind(capability);
  const replacement = '{"owner":"replacement"}\n';
  vi.spyOn(capability, "open").mockImplementationOnce(async (...args) => {
    await fs.rename(lockPath, `${lockPath}.displaced`);
    await fs.writeFile(lockPath, replacement, { flag: "wx" });
    return await realOpen(...args);
  });
  const result = await manager.acquire(target, {
    lockRoot: capability, lockPath, payload: () => ({ owner: "new" }),
  }).then((handle) => ({ handle, error: undefined }), (error: unknown) => ({ handle: undefined, error }));
  try {
    const verified = result.handle ? await result.handle.verifyStillHeld() : undefined;
    console.log(JSON.stringify({ phase: "post-create-before-reopen", admitted: !!result.handle, verified }));
    expect(result.handle).toBeUndefined();
    expect(result.error).toBeDefined();
  } finally {
    await result.handle?.release();
    await manager.drain();
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(replacement);
  }
});

posix.each([
  "root-replaced", "parent-escape", "parent-retarget", "linked-stale-descriptor",
  "unlinked-parent-retarget", "unlinked-parent-replaced",
].flatMap((mutation) => [false, true].map((afterIdentity) => ({ mutation, afterIdentity }))))(
  "refuses $mutation (after identity: $afterIdentity)",
  async ({ mutation, afterIdentity }) => {
    const base = await tempRoot("sidecar-retarget-");
    const rootPath = path.join(base, "root");
    await fs.mkdir(path.join(rootPath, "parent"), { recursive: true });
    const capability = await root(rootPath);
    const relative = "parent/state.lock";
    const lockPath = path.join(capability.rootReal, relative);
    await capability.create(relative, '{"owner":"original"}');
    const probe = vi.spyOn(capability, "stat");
    const opened = mutateOpened(lockPath, async (handle) => {
      if (mutation === "root-replaced") {
        await fs.unlink(lockPath);
        await fs.rename(rootPath, `${rootPath}.old`);
        await fs.mkdir(rootPath);
      } else if (mutation === "linked-stale-descriptor") {
        // Keep the real inode alive outside the root, with no forged metadata.
        await fs.rename(lockPath, path.join(base, "displaced.lock"));
        expect((await handle.stat({ bigint: true })).nlink).toBe(1n);
      } else {
        if (mutation.startsWith("unlinked-")) {
          await fs.unlink(lockPath);
          expect((await handle.stat({ bigint: true })).nlink).toBe(0n);
        }
        const parent = path.dirname(lockPath);
        await fs.rename(parent, path.join(base, "displaced-parent"));
        if (mutation === "unlinked-parent-replaced") {
          await fs.mkdir(parent);
        } else {
          const destination = mutation === "parent-escape" ? path.join(base, "outside") : path.join(rootPath, "other");
          await fs.mkdir(destination);
          await fs.symlink(destination, parent);
        }
      }
    }, afterIdentity);
    const snapshot = readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardUnlinked: true });
    const error = await snapshot.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "FsSafeError" });
    expect(["path-mismatch", "outside-workspace", "path-alias", "not-found"]).toContain((error as { code: string }).code);
    expect(opened()?.fd).toBe(-1);
    expect(probe.mock.calls.length).toBeLessThanOrEqual(1);
    if (mutation !== "root-replaced") {
      const preserved = mutation === "linked-stale-descriptor"
        ? path.join(base, "displaced.lock") : path.join(base, "displaced-parent/state.lock");
      if (mutation.startsWith("unlinked-")) {
        await expect(fs.lstat(preserved)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(fs.readFile(preserved, "utf8")).resolves.toBe('{"owner":"original"}');
      }
    }
  },
);

posix.each(["before-probe", "after-probe"])("replacement %s cannot be acquired or removed by the waiter", async (when) => {
  const capability = await root(await tempRoot("sidecar-probe-replacement-"));
  const relative = "state.lock";
  const lockPath = path.join(capability.rootReal, relative);
  const target = path.join(capability.rootReal, "state");
  const ownerManager = createFileLockManager(`probe-owner:${target}`);
  const waiterManager = createFileLockManager(`probe-waiter:${target}`);
  const options = { lockRoot: capability, lockPath, retry: { retries: 0 }, shouldReclaim: () => false };
  const owner = await ownerManager.acquire(target, { ...options, payload: () => ({ owner: "original" }) });
  const realOpen = capability.open.bind(capability);
  let opened: (() => FileHandle | undefined) | undefined;
  vi.spyOn(capability, "open").mockImplementationOnce(async (...args) => {
    opened = mutateOpened(lockPath, async () => { await owner.release(); });
    return await realOpen(...args);
  });
  const replacement = '{"owner":"replacement"}\n';
  const realStat = capability.stat.bind(capability);
  const probe = vi.spyOn(capability, "stat").mockImplementationOnce(async (...args) => {
    if (when === "before-probe") await fs.writeFile(lockPath, replacement, { flag: "wx" });
    try {
      return await realStat(...args);
    } catch (error) {
      expect(error).toMatchObject({ code: "not-found" });
      await fs.writeFile(lockPath, replacement, { flag: "wx" });
      throw error;
    }
  });
  try {
    await expect(waiterManager.acquire(target, { ...options, payload: () => ({ owner: "waiter" }) }))
      .rejects.toMatchObject({ code: "file_lock_timeout" });
    expect(probe).toHaveBeenCalledExactlyOnceWith(relative);
    expect(opened?.()?.fd).toBe(-1);
    expect(waiterManager.heldEntries()).toEqual([]);
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(replacement);
  } finally {
    __setFsSafeTestHooksForTest();
    await owner.release();
    await waiterManager.drain();
  }
});

posix.each([false, true])("rejects a snapshot replacement (after identity: %s)", async (afterIdentity) => {
  const capability = await root(await tempRoot("sidecar-snapshot-replaced-"));
  const lockPath = path.join(capability.rootReal, "state.lock");
  await capability.create("state.lock", '{"owner":"original"}');
  const opened = mutateOpened(lockPath, async () => {
    await fs.rename(lockPath, `${lockPath}.displaced`);
    await fs.writeFile(lockPath, '{"owner":"replacement"}', { flag: "wx" });
  }, afterIdentity);
  await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardUnlinked: true }))
    .rejects.toMatchObject({ code: "path-mismatch" });
  expect(opened()?.fd).toBe(-1);
  await expect(fs.readFile(lockPath, "utf8")).resolves.toBe('{"owner":"replacement"}');
  await expect(fs.readFile(`${lockPath}.displaced`, "utf8")).resolves.toBe('{"owner":"original"}');
});

posix("rejects a Root replaced after its absence probe", async () => {
  const base = await tempRoot("sidecar-probe-root-swap-");
  const rootPath = path.join(base, "root");
  await fs.mkdir(rootPath);
  const capability = await root(rootPath);
  const lockPath = path.join(capability.rootReal, "state.lock");
  await capability.create("state.lock", "{}");
  const opened = mutateOpened(lockPath, async () => { await fs.unlink(lockPath); });
  const stat = capability.stat.bind(capability);
  vi.spyOn(capability, "stat").mockImplementationOnce(async (...args) => {
    try {
      return await stat(...args);
    } catch (error) {
      expect(error).toMatchObject({ code: "not-found" });
      await fs.rename(rootPath, `${rootPath}.old`);
      await fs.mkdir(rootPath);
      throw error;
    }
  });
  await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardUnlinked: true }))
    .rejects.toMatchObject({ code: "path-mismatch" });
  expect(opened()?.fd).toBe(-1);
});

posix.each(["retry", "deadline"])("bounds repeated post-create loss by the %s policy", async (limit) => {
  const capability = await root(await tempRoot("sidecar-lost-budget-"));
  const target = path.join(capability.rootReal, "state");
  const lockPath = `${target}.lock`;
  const manager = createFileLockManager(`lost-budget:${target}`);
  const create = vi.spyOn(capability, "create");
  const originalOpen = capability.open.bind(capability);
  const descriptors: FileHandle[] = [];
  vi.spyOn(capability, "open").mockImplementation(async (...args) => {
    mutateOpened(lockPath, async (handle) => {
      descriptors.push(handle);
      await fs.unlink(lockPath);
      expect((await handle.stat({ bigint: true })).nlink).toBe(0n);
    });
    return await originalOpen(...args);
  });
  await expect(manager.acquire(target, {
    lockRoot: capability, payload: () => ({}),
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
    ...(limit === "deadline" ? { timeoutMs: 0 } : {}),
  })).rejects.toMatchObject({ code: "file_lock_timeout" });
  expect(create).toHaveBeenCalledTimes(limit === "retry" ? 2 : 1);
  expect(descriptors.every((handle) => handle.fd === -1)).toBe(true);
  expect(manager.heldEntries()).toEqual([]);
  await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

posix.each(["retry", "deadline", "replacement"])("does not register a record unlinked during admission read (%s)", async (kind) => {
  const capability = await root(await tempRoot("sidecar-read-loss-"));
  const target = path.join(capability.rootReal, "state"), lockPath = `${target}.lock`;
  const manager = createFileLockManager(`read-loss:${target}`);
  const open = capability.open.bind(capability);
  let descriptor: FileHandle | undefined;
  vi.spyOn(capability, "open").mockImplementationOnce(async (...args) => {
    const opened = await open(...args);
    descriptor = opened.handle;
    const read = opened.handle.read.bind(opened.handle);
    vi.spyOn(opened.handle, "read").mockImplementationOnce(async (...values: Parameters<typeof read>) => {
      const result = await read(...values);
      await fs.unlink(lockPath);
      if (kind === "replacement") await fs.writeFile(lockPath, '{"owner":"replacement"}');
      return result;
    });
    return opened;
  });
  const pending = manager.acquire(target, {
    lockRoot: capability, payload: () => ({ owner: "creator" }),
    retry: { retries: kind === "retry" ? 1 : 0, minTimeout: 0, maxTimeout: 0 },
    ...(kind === "deadline" ? { timeoutMs: 0 } : {}),
  });
  if (kind === "retry") {
    const held = await pending;
    await expect(held.verifyStillHeld()).resolves.toBe(true);
    await held.release();
  } else await expect(pending).rejects.toMatchObject({ code: "file_lock_timeout" });
  expect(descriptor?.fd).toBe(-1);
  expect(manager.heldEntries()).toEqual([]);
  if (kind === "replacement") await expect(fs.readFile(lockPath, "utf8")).resolves.toBe('{"owner":"replacement"}');
  else await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

posix("creator cleanup retains its token when a later stat fails over a replacement", async () => {
  const capability = await root(await tempRoot("sidecar-creator-cleanup-"));
  const target = path.join(capability.rootReal, "state"), lockPath = `${target}.lock`;
  const manager = createFileLockManager(`creator-cleanup:${target}`);
  const open = capability.open.bind(capability);
  const failure = Object.assign(new Error("admission stat failure"), { code: "EIO" });
  let descriptor: FileHandle | undefined;
  vi.spyOn(capability, "open").mockImplementationOnce(async (...args) => {
    const opened = await open(...args);
    descriptor = opened.handle;
    const stat = opened.handle.stat.bind(opened.handle);
    vi.spyOn(opened.handle, "stat").mockImplementationOnce(async () => {
      await fs.rename(lockPath, `${lockPath}.displaced`);
      await fs.writeFile(lockPath, '{"owner":"replacement"}');
      throw failure;
    }).mockImplementation(stat);
    return opened;
  });
  await expect(manager.acquire(target, { lockRoot: capability, payload: () => ({ owner: "creator" }) })).rejects.toBe(failure);
  expect(descriptor?.fd).toBe(-1);
  expect(manager.heldEntries()).toEqual([]);
  await expect(fs.readFile(lockPath, "utf8")).resolves.toBe('{"owner":"replacement"}');
  expect(JSON.parse(await fs.readFile(`${lockPath}.displaced`, "utf8"))).toEqual({ owner: "creator" });
});
