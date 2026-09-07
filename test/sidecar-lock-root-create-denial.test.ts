import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileLockManager } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const retry = { minTimeout: 0, maxTimeout: 0 };
const denial = (filePath: string, code = "EPERM") =>
  Object.assign(new Error("synthetic exclusive-create denial"), { code, syscall: "open", path: filePath });
const exclusive = (flags: unknown) => typeof flags === "number" &&
  (flags & (fs.constants.O_CREAT | fs.constants.O_EXCL)) === (fs.constants.O_CREAT | fs.constants.O_EXCL);

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  configureFsSafeNative({ mode: "auto" });
});

async function fixture() {
  const directory = await tempRoot("fs-safe-root-create-denial-");
  configureFsSafeNative({ mode: "off" });
  const lockRoot = await root(directory);
  const target = path.join(directory, "state");
  const lockPath = `${target}.lock`;
  const manager = createFileLockManager(`root-create-denial:${target}`);
  Object.defineProperty(process, "platform", { value: "win32" });
  const options = { lockRoot, payload: () => ({ pid: process.pid }), staleMs: 60_000, timeoutMs: Infinity, retry };
  return { directory, target, lockPath, lockRoot, manager, options };
}

describe("Root exclusive-create denial (synthetic Windows/errno; real files)", () => {
  it("retries a genuine fallback exclusive-open denial and admits only the fresh creator", async () => {
    const { target, lockPath, manager, options } = await fixture();
    const error = denial(lockPath);
    const realOpen = fsp.open.bind(fsp);
    let attempts = 0;
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      if (args[0] === lockPath && exclusive(args[1]) && ++attempts === 1) throw error;
      return await realOpen(...args);
    });

    const handle = await manager.acquire(target, options);
    try {
      expect(attempts).toBe(2);
      expect(await handle.verifyStillHeld()).toBe(true);
      expect(JSON.parse(await fsp.readFile(lockPath, "utf8"))).toEqual({ pid: process.pid });
    } finally {
      await handle.release();
    }
    expect(manager.heldEntries()).toEqual([]);
    await expect(fsp.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([{ retries: 0, attempts: 1 }, { retries: 2, attempts: 3 }, { retries: 20, attempts: 9 }])(
    "preserves the original denial with $retries caller retries", async ({ retries, attempts }) => {
      const { directory, target, lockPath, manager, options } = await fixture();
      const error = denial(lockPath);
      const keys = Reflect.ownKeys(error);
      const realOpen = fsp.open.bind(fsp);
      let denied = 0;
      vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
        if (args[0] === lockPath && exclusive(args[1])) { denied += 1; throw error; }
        return await realOpen(...args);
      });

      await expect(manager.acquire(target, { ...options, retry: { ...retry, retries } })).rejects.toBe(error);
      expect(denied).toBe(attempts);
      expect(Reflect.ownKeys(error)).toEqual(keys);
      expect(manager.heldEntries()).toEqual([]);
      expect(await fsp.readdir(directory)).toEqual([]);
    },
  );

  it("preserves the denial when the finite deadline expires", async () => {
    const { directory, target, lockPath, manager, options } = await fixture();
    const error = denial(lockPath);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const realOpen = fsp.open.bind(fsp);
    let attempts = 0;
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      if (args[0] === lockPath && exclusive(args[1])) {
        attempts += 1;
        clock.mockReturnValue(now + 100);
        throw error;
      }
      return await realOpen(...args);
    });
    await expect(manager.acquire(target, { ...options, timeoutMs: 10 })).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(await fsp.readdir(directory)).toEqual([]);
  });

  it.each(["parent", "other-file", "unpathed", "EACCES", "EIO"])(
    "does not retry an exclusive-open error classified as %s", async (kind) => {
      const { directory, target, lockPath, manager, options } = await fixture();
      const error = denial(kind === "parent" ? directory : kind === "other-file" ? `${lockPath}.other` : lockPath,
        kind === "EACCES" || kind === "EIO" ? kind : "EPERM");
      if (kind === "unpathed") Reflect.deleteProperty(error, "path");
      const realOpen = fsp.open.bind(fsp);
      let attempts = 0;
      vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
        if (args[0] === lockPath && exclusive(args[1])) { attempts += 1; throw error; }
        return await realOpen(...args);
      });
      await expect(manager.acquire(target, options)).rejects.toBe(error);
      expect(attempts).toBe(1);
      expect(manager.heldEntries()).toEqual([]);
    },
  );

  it("shares the eight-denial cap between Root creation and snapshot opens", async () => {
    const { target, lockPath, manager, options } = await fixture();
    const error = denial(lockPath);
    const foreign = '{"owner":"foreign"}\n';
    const realOpen = fsp.open.bind(fsp);
    let createDenials = 0;
    let readDenials = 0;
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      if (args[0] === lockPath) {
        if (exclusive(args[1]) && createDenials < 4) {
          if (++createDenials === 4) await fsp.writeFile(lockPath, foreign);
          throw error;
        }
        if (typeof args[1] === "number" && !(args[1] & fs.constants.O_EXCL)) {
          readDenials += 1;
          throw error;
        }
      }
      return await realOpen(...args);
    });
    const shouldReclaim = vi.fn(() => true);
    await expect(manager.acquire(target, { ...options, shouldReclaim })).rejects.toBe(error);
    expect(createDenials).toBe(4);
    expect(readDenials).toBe(5);
    expect(shouldReclaim).not.toHaveBeenCalled();
    expect(manager.heldEntries()).toEqual([]);
    await expect(fsp.readFile(lockPath, "utf8")).resolves.toBe(foreign);
  });

  it("does not accept a fresh wrapper error without exclusive-open provenance", async () => {
    const { target, lockPath, lockRoot, manager, options } = await fixture();
    const error = denial(lockPath);
    const create = vi.spyOn(lockRoot, "create").mockRejectedValue(error);
    await expect(manager.acquire(target, options)).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
    expect(manager.heldEntries()).toEqual([]);
  });

  it("does not reuse a genuine denial receipt on the next attempt", async () => {
    const { target, lockPath, lockRoot, manager, options } = await fixture();
    const error = denial(lockPath);
    const realOpen = fsp.open.bind(fsp);
    let opens = 0;
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      if (args[0] === lockPath && exclusive(args[1])) { opens += 1; throw error; }
      return await realOpen(...args);
    });
    const create = lockRoot.create.bind(lockRoot);
    const wrapper = vi.spyOn(lockRoot, "create")
      .mockImplementationOnce(create)
      .mockRejectedValue(error);
    await expect(manager.acquire(target, options)).rejects.toBe(error);
    expect(wrapper).toHaveBeenCalledTimes(2);
    expect(opens).toBe(1);
    expect(manager.heldEntries()).toEqual([]);
  });

  it("does not reinterpret an ordinary Root open as an exclusive create", async () => {
    const { target, lockPath, lockRoot, manager, options } = await fixture();
    const error = denial(lockPath);
    const foreign = '{"owner":"foreign"}\n';
    await fsp.writeFile(lockPath, foreign);
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      if (args[0] === lockPath && typeof args[1] === "number" && !exclusive(args[1])) throw error;
      return await realOpen(...args);
    });
    const create = vi.spyOn(lockRoot, "create").mockImplementation(async () => {
      const opened = await lockRoot.open("state.lock");
      await opened.handle.close();
    });
    await expect(manager.acquire(target, options)).rejects.toBe(error);
    expect(create).toHaveBeenCalledTimes(1);
    expect(manager.heldEntries()).toEqual([]);
    await expect(fsp.readFile(lockPath, "utf8")).resolves.toBe(foreign);
  });

  it("keeps another Root target's exclusive-create failure out of this receipt", async () => {
    const { directory, target, lockPath, lockRoot, manager, options } = await fixture();
    const error = denial(lockPath);
    const realOpen = fsp.open.bind(fsp);
    const otherPath = path.join(directory, "other.lock");
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      if (args[0] === otherPath && exclusive(args[1])) throw error;
      return await realOpen(...args);
    });
    const create = lockRoot.create.bind(lockRoot);
    const wrapper = vi.spyOn(lockRoot, "create").mockImplementation(async () => create("other.lock", "other"));
    await expect(manager.acquire(target, options)).rejects.toBe(error);
    expect(wrapper).toHaveBeenCalledTimes(1);
    expect(await fsp.readdir(directory)).toEqual([]);
  });

  it.each(["wrapper", "payload", "toJSON", "parsePayload"] as const)(
    "does not replay a prior acquisition's exclusive-create receipt through %s", async (callback) => {
      const { target, lockPath, lockRoot, manager, options } = await fixture();
      const error = denial(lockPath);
      const realOpen = fsp.open.bind(fsp);
      const open = vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
        if (args[0] === lockPath && exclusive(args[1])) throw error;
        return await realOpen(...args);
      });
      await expect(manager.acquire(target, { ...options, retry: { ...retry, retries: 0 } })).rejects.toBe(error);
      open.mockRestore();
      const foreign = '{"owner":"foreign"}\n';
      await fsp.writeFile(lockPath, foreign);
      const fail = vi.fn((): never => { throw error; });
      if (callback === "wrapper") vi.spyOn(lockRoot, "create").mockImplementation(fail);
      const shouldReclaim = vi.fn(() => true);
      await expect(manager.acquire(target, {
        ...options,
        payload: callback === "payload" ? fail : () => callback === "toJSON" ? { toJSON: fail } : {},
        parsePayload: callback === "parsePayload" ? fail : JSON.parse,
        shouldReclaim,
      })).rejects.toBe(error);
      expect(fail).toHaveBeenCalledTimes(1);
      expect(shouldReclaim).not.toHaveBeenCalled();
      expect(manager.heldEntries()).toEqual([]);
      await expect(fsp.readFile(lockPath, "utf8")).resolves.toBe(foreign);
    },
  );

  it.each(["write", "stat"])("does not retry a pathed EPERM from a post-create %s failure", async (operation) => {
    const { directory, target, lockPath, manager, options } = await fixture();
    const error = denial(lockPath);
    const realOpen = fsp.open.bind(fsp);
    let attempts = 0;
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === lockPath && exclusive(args[1])) {
        attempts += 1;
        if (operation === "write") vi.spyOn(handle, "writeFile").mockRejectedValue(error);
        else {
          const realStat = fs.fstatSync.bind(fs);
          vi.spyOn(fs, "fstatSync").mockImplementation((fd, options) => {
            if (fd === handle.fd && options?.bigint) throw error;
            return realStat(fd, options);
          });
        }
      }
      return handle;
    });
    await expect(manager.acquire(target, options)).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(manager.heldEntries()).toEqual([]);
    expect(await fsp.readdir(directory)).toEqual([]);
  });
});
