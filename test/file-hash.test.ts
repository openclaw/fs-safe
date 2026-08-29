import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix } from "./helpers/vitest.js";
import { expectedHashOpenFlags, hashIdentity } from "./helpers/file-hash-identity.js";
import { sha256File } from "../src/file-hash.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-hash-"));
  tempDirs.push(root);
  return root;
}

async function createFifo(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("mkfifo", [filePath]);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mkfifo exited ${code}`));
    });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  await Promise.all(tempDirs.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("sha256File", () => {
  it("streams a path through the JavaScript fallback", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "payload.bin");
    await fs.writeFile(filePath, "abc");
    configureFsSafeNative({ mode: "off" });

    await expect(sha256File(filePath)).resolves.toEqual({
      bytes: 3,
      digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });

  it("does not close a caller-owned handle or change its current offset", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "position.bin");
    await fs.writeFile(filePath, "abcdef");
    const handle = await fs.open(filePath, "r");
    configureFsSafeNative({ mode: "off" });
    try {
      const prefix = Buffer.alloc(2);
      await handle.read(prefix, 0, prefix.length, null);
      await expect(sha256File(handle)).resolves.toMatchObject({ bytes: 6 });
      const next = Buffer.alloc(1);
      await handle.read(next, 0, next.length, null);
      expect(next.toString()).toBe("c");
    } finally {
      await handle.close();
    }
  });

  it.each(["read", "stat", "native"] as const)(
    "keeps a caller-owned handle open and its offset unchanged on %s failure",
    async (failureAt) => {
      const root = await tempRoot();
      const filePath = path.join(root, "position.bin");
      await fs.writeFile(filePath, "abcdef");
      const handle = await fs.open(filePath, "r");
      const failure = new Error("hash failed");
      configureFsSafeNative({ mode: failureAt === "native" ? "auto" : "off" });
      try {
        await handle.read(Buffer.alloc(2), 0, 2, null);
        const close = vi.spyOn(handle, "close");
        const open = vi.spyOn(fs, "open");
        const lstat = vi.spyOn(fs, "lstat");
        if (failureAt === "native") {
          const nativeHash = vi.fn(async () => { throw failure; });
          __setNativeLoaderForTest(() => ({ sha256File: nativeHash }) as unknown as NativeBinding);
        } else {
          vi.spyOn(handle, failureAt).mockRejectedValueOnce(failure);
        }
        await expect(sha256File(handle)).rejects.toBe(failure);
        expect(close).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(lstat).not.toHaveBeenCalled();
        const next = Buffer.alloc(1);
        await handle.read(next, 0, next.length, null);
        expect(next.toString()).toBe("c");
      } finally {
        await handle.close();
      }
    },
  );

  it.each(["ELOOP", "EACCES"])("preserves open failure mapping for %s", async (code) => {
    const root = await tempRoot();
    const filePath = path.join(root, "payload.bin");
    await fs.writeFile(filePath, "abc");
    const failure = Object.assign(new Error("open failed"), { code });
    const realOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === filePath) throw failure;
      return await realOpen(...args);
    });
    const loader = vi.fn();
    __setNativeLoaderForTest(loader);
    if (code === "ELOOP") {
      await expect(sha256File(filePath)).rejects.toMatchObject({ code: "symlink", cause: failure });
    } else {
      await expect(sha256File(filePath)).rejects.toBe(failure);
    }
    expect(open.mock.calls).toEqual([[filePath, expectedHashOpenFlags()]]);
    expect(loader).not.toHaveBeenCalled();
  });

  it.each(["read", "native"] as const)("closes its owned handle once on %s failure", async (failureAt) => {
    const root = await tempRoot();
    const filePath = path.join(root, "payload.bin");
    await fs.writeFile(filePath, "abc");
    const failure = new Error("hash failed");
    configureFsSafeNative({ mode: failureAt === "native" ? "auto" : "off" });
    const nativeHash = vi.fn(async () => { throw failure; });
    __setNativeLoaderForTest(() => ({ sha256File: nativeHash }) as unknown as NativeBinding);
    const realOpen = fs.open.bind(fs);
    let close: ReturnType<typeof vi.spyOn> | undefined;
    let read: ReturnType<typeof vi.spyOn> | undefined;
    let handle: fs.FileHandle | undefined;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const opened = await realOpen(...args);
      if (args[0] === filePath) {
        handle = opened;
        close = vi.spyOn(opened, "close");
        read = vi.spyOn(opened, "read");
        if (failureAt === "read") read.mockRejectedValueOnce(failure);
      }
      return opened;
    });
    await expect(sha256File(filePath)).rejects.toBe(failure);
    expect(open.mock.calls).toEqual([[filePath, expectedHashOpenFlags()]]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(handle!.fd).toBe(-1);
    expect(read).toHaveBeenCalledTimes(failureAt === "read" ? 1 : 0);
    expect(nativeHash).toHaveBeenCalledTimes(failureAt === "native" ? 1 : 0);
  });

  it("uses the native async hash when the binding is available", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "native.bin");
    await fs.writeFile(filePath, "native");
    const nativeHash = vi.fn(async () => ({ bytes: 6, digest: "native-digest" }));
    __setNativeLoaderForTest(
      () => ({ sha256File: nativeHash }) as unknown as NativeBinding,
    );

    await expect(sha256File(filePath)).resolves.toEqual({
      bytes: 6,
      digest: "native-digest",
    });
    expect(nativeHash).toHaveBeenCalledOnce();
  });

  itPosix("rejects symbolic-link path inputs", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "payload.bin");
    const linkPath = path.join(root, "link.bin");
    await fs.writeFile(filePath, "payload");
    await fs.symlink(filePath, linkPath);

    await expect(sha256File(linkPath)).rejects.toMatchObject({ code: "symlink" });
  });

  it.each([
    { model: "real", timing: "before-open" },
    { model: "high-bigint", timing: "before-open" },
    { model: "real", timing: "after-open" },
    { model: "high-bigint", timing: "after-open" },
  ] as const)("rejects a real retained replacement ($model, $timing)", async ({ model, timing }) => {
    const root = await tempRoot();
    const filePath = path.join(root, "payload.bin");
    const displacedPath = path.join(root, "payload.displaced");
    const unrelatedPath = path.join(root, "unrelated.bin");
    await fs.writeFile(filePath, "original");
    await fs.writeFile(unrelatedPath, "auxiliary");
    configureFsSafeNative({ mode: "off" });
    const originalLstat = fs.lstat.bind(fs);
    const originalOpen = fs.open.bind(fs);
    const identity = (stat: fsSync.Stats | fsSync.BigIntStats) => ({ dev: stat.dev, ino: stat.ino });
    const before = identity(await originalLstat(filePath, { bigint: true }));
    const events: string[] = [];
    const observations: { stage: string; bigint: boolean; raw: ReturnType<typeof identity>; delivered: ReturnType<typeof identity> }[] = [];
    let armed = true;
    let swaps = 0;
    let close: ReturnType<typeof vi.spyOn> | undefined;
    let read: ReturnType<typeof vi.spyOn> | undefined;
    let opened: fs.FileHandle | undefined;

    function observe(stage: string, stat: fsSync.Stats | fsSync.BigIntStats, bigint: boolean) {
      events.push(stage);
      const raw = identity(stat);
      if (model === "high-bigint") {
        // Only the representation is synthetic; both retained files and their
        // opened descriptors are real. This does not model a specific CI event.
        const isOriginal = bigint
          ? raw.dev === before.dev && raw.ino === before.ino
          : raw.dev === Number(before.dev) && raw.ino === Number(before.ino);
        const ino = isOriginal ? hashIdentity.ino : hashIdentity.ino + 1n;
        stat.dev = bigint ? hashIdentity.dev : Number(hashIdentity.dev);
        stat.ino = bigint ? ino : Number(ino);
      }
      observations.push({ stage, bigint, raw, delivered: identity(stat) });
      return stat;
    }
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      return args[0] === filePath
        ? observe(opened ? "current" : "preview", stat, args[1]?.bigint === true)
        : stat;
    });
    async function replace() {
      expect(armed).toBe(true);
      armed = false;
      swaps++;
      events.push("swap");
      await fs.rename(filePath, displacedPath);
      await fs.writeFile(filePath, "replacement");
    }
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] !== filePath) {
        events.push("unrelated-open");
        return await originalOpen(...args);
      }
      events.push("target-open");
      if (armed && timing === "before-open") await replace();
      const handle = await originalOpen(...args);
      opened = handle;
      close = vi.spyOn(handle, "close");
      read = vi.spyOn(handle, "read");
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (options) =>
        observe("descriptor", await stat(options), options?.bigint === true),
      );
      if (armed && timing === "after-open") await replace();
      return handle;
    });

    // An unrelated open before preview cannot consume the armed injection.
    const unrelated = await fs.open(unrelatedPath, "r");
    await unrelated.close();
    expect(armed).toBe(true);
    expect(swaps).toBe(0);
    await expect(sha256File(filePath)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(open.mock.calls).toEqual([[unrelatedPath, "r"], [filePath, expectedHashOpenFlags()]]);
    expect(events).toEqual([
      "unrelated-open", "preview", "target-open", "swap", "descriptor",
      ...(timing === "after-open" ? ["current"] : []),
    ]);
    expect(swaps).toBe(1);
    expect(armed).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(opened!.fd).toBe(-1);
    for (const observation of observations) {
      expect(observation.bigint).toBe(true);
      expect(typeof observation.delivered.dev).toBe("bigint");
      expect(typeof observation.delivered.ino).toBe("bigint");
    }
    const displaced = identity(await originalLstat(displacedPath, { bigint: true }));
    const replacement = identity(await originalLstat(filePath, { bigint: true }));
    expect(displaced).toEqual(before);
    expect(replacement.ino).not.toBe(displaced.ino);
    expect(observations.map(({ raw }) => raw)).toEqual(
      timing === "before-open" ? [before, replacement] : [before, before, replacement],
    );
    if (model === "high-bigint") {
      expect(Number(hashIdentity.ino)).toBe(Number(hashIdentity.ino + 1n));
      const exactOriginal = hashIdentity;
      const exactReplacement = { ...hashIdentity, ino: hashIdentity.ino + 1n };
      expect(observations.map(({ delivered }) => delivered)).toEqual(timing === "before-open"
        ? [exactOriginal, exactReplacement] : [exactOriginal, exactOriginal, exactReplacement]);
    }
    await expect(fs.readFile(displacedPath, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
    await expect(fs.readFile(unrelatedPath, "utf8")).resolves.toBe("auxiliary");
  });

  itPosix("rejects a FIFO swapped in before open without blocking", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "payload.bin");
    const displacedPath = path.join(root, "payload.displaced");
    await fs.writeFile(filePath, "payload");
    configureFsSafeNative({ mode: "off" });
    const originalOpen = fs.open.bind(fs);
    let armed = true;
    let close: ReturnType<typeof vi.spyOn> | undefined;
    let read: ReturnType<typeof vi.spyOn> | undefined;
    const open = vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      if (candidate === filePath && armed) {
        armed = false;
        expect(typeof flags).toBe("number");
        expect((flags as number) & fsSync.constants.O_NONBLOCK).toBe(
          fsSync.constants.O_NONBLOCK,
        );
        await fs.rename(filePath, displacedPath);
        await createFifo(filePath);
      }
      const handle = await originalOpen(candidate, flags, mode);
      if (candidate === filePath) {
        close = vi.spyOn(handle, "close");
        read = vi.spyOn(handle, "read");
      }
      return handle;
    });

    await expect(sha256File(filePath)).rejects.toMatchObject({ code: "not-file" });
    expect(open.mock.calls).toEqual([[filePath, expectedHashOpenFlags()]]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });
});
