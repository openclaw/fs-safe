import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinNodeDirectoryForMode } from "../src/directory-mode-node.js";
import { applyDirectoryMode } from "../src/replace-file-descriptor.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(process.platform === "win32")("directory mode ownership", () => {
  it("keeps partial injected adapters on descriptor chmod without host fd operations", async () => {
    const dir = await tempRoot("fs-safe-mode-adapter-");
    const identity = await fs.stat(dir);
    let mode = 0o300;
    const descriptorChmod = vi.fn(async (next: number) => { mode = next; });
    const close = vi.fn(async () => undefined);
    const fake = { fd: 1234567, stat: async () => ({ ...identity, mode, isDirectory: () => true, isSymbolicLink: () => false }), chmod: descriptorChmod, close };
    const adapter = {
      lstat: vi.fn(async () => identity), open: vi.fn(async () => fake), writeFile: vi.fn(),
    } as unknown as Pick<typeof fs, "lstat" | "open" | "writeFile">;
    const hostOpen = vi.spyOn(fs, "open");
    const hostChmod = vi.spyOn(fs, "chmod");
    const hostStatfs = vi.spyOn(fs, "statfs");
    await applyDirectoryMode({ fsModule: adapter, dirPath: dir, mode: 0o755 });
    expect(descriptorChmod).toHaveBeenCalledExactlyOnceWith(0o755);
    expect(close).toHaveBeenCalledTimes(1);
    expect(hostOpen).not.toHaveBeenCalled();
    expect(hostChmod).not.toHaveBeenCalled();
    expect(hostStatfs).not.toHaveBeenCalled();
  });

  it("uses no procfs for readable directories and skips an already verified mode", async () => {
    const dir = await tempRoot("fs-safe-mode-readable-");
    await fs.chmod(dir, 0o700);
    const proc = vi.spyOn(fs, "statfs").mockRejectedValue(new Error("procfs unavailable"));
    const pathChmod = vi.spyOn(fs, "chmod").mockRejectedValue(new Error("unexpected pathname chmod"));
    const owner = await pinNodeDirectoryForMode(dir);
    try {
      await owner.apply(0o700);
      await owner.apply(0o750);
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o750);
      expect(proc).not.toHaveBeenCalled();
      expect(pathChmod).not.toHaveBeenCalled();
    } finally { await owner.close(); }
  });

  it("serializes apply and close, rejects later use and closes once", async () => {
    const dir = await tempRoot("fs-safe-mode-lifetime-");
    await fs.chmod(dir, 0o700);
    const entered = deferred();
    const release = deferred();
    const realOpen = fs.open.bind(fs);
    let fd = -1;
    let closes = 0;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      fd = handle.fd;
      const chmod = handle.chmod.bind(handle);
      const close = handle.close.bind(handle);
      handle.chmod = async (mode) => { entered.resolve(); await release.promise; await chmod(mode); };
      handle.close = async () => { closes++; await close(); };
      return handle;
    });
    const owner = await pinNodeDirectoryForMode(dir);
    const apply = owner.apply(0o555);
    await entered.promise;
    const closing = owner.close();
    expect(fsSync.fstatSync(fd).isDirectory()).toBe(true);
    expect(closes).toBe(0);
    await expect(owner.apply(0o700)).rejects.toThrow("closed");
    release.resolve();
    await apply;
    await closing;
    await owner.close();
    expect(closes).toBe(1);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o555);
    expect(() => fsSync.fstatSync(fd)).toThrow();
    await fs.chmod(dir, 0o700);
  });

  it("does not fall back on a descriptor chmod failure", async () => {
    const dir = await tempRoot("fs-safe-mode-error-");
    await fs.chmod(dir, 0o700);
    const realOpen = fs.open.bind(fs);
    const chmodError = Object.assign(new Error("chmod failed"), { code: "EBADF" });
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      handle.chmod = async () => { throw chmodError; };
      return handle;
    });
    const pathname = vi.spyOn(fs, "chmod");
    const owner = await pinNodeDirectoryForMode(dir);
    try {
      await expect(owner.apply(0o755)).rejects.toBe(chmodError);
      expect(pathname).not.toHaveBeenCalled();
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    } finally { await owner.close(); }
  });
});
