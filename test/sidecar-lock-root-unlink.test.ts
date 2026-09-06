import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
});

// Intercept the actual descriptor resolver; all identities come from the filesystem.
function atFdResolution(lockPath: string, mutate: (handle: FileHandle) => Promise<void>) {
  let opened: FileHandle | undefined;
  let fired = false;
  let mutation: Promise<void> | undefined;
  const realpath = fs.realpath.bind(fs);
  const wrapper = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
    const candidate = String(args[0]);
    // After afterOpen, the resolver probes procfs on Linux and the lock path elsewhere.
    if (!fired && opened && candidate === (process.platform === "linux" ? `/proc/self/fd/${opened.fd}` : lockPath)) {
      fired = true;
      __setFsSafeTestHooksForTest();
      mutation = mutate(opened);
      await mutation;
    }
    return await realpath(...args);
  });
  __setFsSafeTestHooksForTest({
    afterOpen(candidate, handle) {
      if (candidate === lockPath && !opened) opened = handle;
    },
  });
  return {
    get opened() { return opened; },
    get fired() { return fired; },
    async join() { await mutation; },
    restore() { wrapper.mockRestore(); __setFsSafeTestHooksForTest(); },
  };
}

it.skipIf(process.platform === "win32").each(["snapshot"] as const)(
  "completed owner release permits successor at %s FD resolution",
  async (phase) => {
    const capability = await root(await tempRoot("sidecar-discovery-"));
    const target = path.join(capability.rootReal, "state");
    const relative = "state.lock";
    const lockPath = path.join(capability.rootReal, relative);
    const ownerManager = createFileLockManager(`discovery-owner:${target}`);
    const waiterManager = createFileLockManager(`discovery-waiter:${target}`);
    const shouldReclaim = vi.fn(() => false);
    const options = { lockRoot: capability, lockPath, shouldReclaim, retry: { retries: 1, minTimeout: 0, maxTimeout: 0 } };
    const owner = await ownerManager.acquire(target, { ...options, payload: () => ({ owner: "original" }) });
    const ownerRaw = await fs.readFile(lockPath, "utf8");
    const events: string[] = [];
    let gate: ReturnType<typeof atFdResolution> | undefined;
    const mutate = async (handle: FileHandle) => {
      const descriptor = await handle.stat({ bigint: true });
      const pathname = await fs.lstat(lockPath, { bigint: true });
      expect([descriptor.dev, descriptor.ino]).toEqual([pathname.dev, pathname.ino]);
      events.push("descriptor-and-path-match-at-fd-resolver");
      await owner.release();
      events.push("owner-release-joined");
      await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await handle.stat({ bigint: true })).nlink).toBe(0n);
      expect(ownerManager.heldEntries()).toHaveLength(0);
      events.push("pathname-absent-descriptor-nlink-zero");
    };
    const realCreate = capability.create.bind(capability);
    vi.spyOn(capability, "create").mockImplementation(async (...args) => {
      try {
        await realCreate(...args);
        events.push("create-succeeded");
      } catch (error) {
        events.push(`create:${(error as { code: string }).code}`);
        throw error;
      }
    });
    const realOpen = capability.open.bind(capability);
    vi.spyOn(capability, "open").mockImplementation(async (...args) => {
      if (phase === "snapshot" && !gate) {
        expect(events).toEqual(["create:already-exists"]);
        gate = atFdResolution(lockPath, mutate);
      }
      return await realOpen(...args);
    });
    const result = await waiterManager.acquire(target, { ...options, payload: () => ({ owner: "waiter" }) })
      .then((handle) => ({ handle, error: undefined }), (error: unknown) => ({ handle: undefined, error }));
    try {
      await gate?.join();
      expect(gate?.fired).toBe(true);
      expect(gate?.opened?.fd).toBe(-1);
      console.log(JSON.stringify({ phase, events, error: result.error && {
        name: (result.error as Error).name,
        code: (result.error as { code: string }).code,
        message: (result.error as Error).message,
      }, closed: gate?.opened?.fd === -1 }));
      expect(result.error).toBeUndefined();
      expect(result.handle).toBeDefined();
      expect(shouldReclaim).not.toHaveBeenCalled();
      const raw = await fs.readFile(lockPath, "utf8");
      expect(JSON.parse(raw)).toEqual({ owner: "waiter" });
      expect(raw).not.toBe(ownerRaw);
      await expect(result.handle!.verifyStillHeld()).resolves.toBe(true);
    } finally {
      gate?.restore();
      await result.handle?.release();
      await owner.release();
      await ownerManager.drain();
      await waiterManager.drain();
      expect(waiterManager.heldEntries()).toHaveLength(0);
      await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it("owner release during create-only preflight needs no existing-file descriptor", async () => {
  const capability = await root(await tempRoot("sidecar-create-preflight-"));
  const target = path.join(capability.rootReal, "state"), lockPath = `${target}.lock`;
  const ownerManager = createFileLockManager(`preflight-owner:${target}`);
  const waiterManager = createFileLockManager(`preflight-waiter:${target}`);
  const owner = await ownerManager.acquire(target, { lockRoot: capability, payload: () => ({ owner: 1 }) });
  let fired = false;
  const open = vi.fn();
  __setFsSafeTestHooksForTest({ afterOpen: open });
  const stat = fs.stat.bind(fs);
  vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
    const result = await stat(...args);
    if (String(args[0]) === lockPath && !fired) {
      fired = true;
      expect(open).not.toHaveBeenCalled();
      __setFsSafeTestHooksForTest();
      await owner.release();
    }
    return result;
  });
  const waiter = await waiterManager.acquire(target, {
    lockRoot: capability, payload: () => ({ owner: 2 }), shouldReclaim: () => false,
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
  });
  try {
    expect(fired).toBe(true);
    await expect(waiter.verifyStillHeld()).resolves.toBe(true);
  } finally {
    await waiter.release();
    await owner.release();
  }
  expect(ownerManager.heldEntries()).toEqual([]);
  expect(waiterManager.heldEntries()).toEqual([]);
});
