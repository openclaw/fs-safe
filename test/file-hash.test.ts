import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix } from "./helpers/vitest.js";
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

  it("rejects a regular file replaced between inspection and open", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "payload.bin");
    const displacedPath = path.join(root, "payload.displaced");
    await fs.writeFile(filePath, "original");
    configureFsSafeNative({ mode: "off" });
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      await fs.rename(filePath, displacedPath);
      await fs.writeFile(filePath, "replacement");
      return await originalOpen(...args);
    });

    await expect(sha256File(filePath)).rejects.toMatchObject({ code: "path-mismatch" });
  });

  itPosix("rejects a FIFO swapped in before open without blocking", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "payload.bin");
    const displacedPath = path.join(root, "payload.displaced");
    await fs.writeFile(filePath, "payload");
    configureFsSafeNative({ mode: "off" });
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      if (candidate === filePath) {
        expect(typeof flags).toBe("number");
        expect((flags as number) & fsSync.constants.O_NONBLOCK).toBe(
          fsSync.constants.O_NONBLOCK,
        );
        await fs.rename(filePath, displacedPath);
        await createFifo(filePath);
      }
      return await originalOpen(candidate, flags, mode);
    });

    await expect(sha256File(filePath)).rejects.toMatchObject({ code: "not-file" });
  });
});
