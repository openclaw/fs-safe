import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRegularFile, readRegularFileSync } from "../src/advanced.js";
import { replaceFileAtomic } from "../src/atomic.js";
import { configureFsSafeNative } from "../src/config.js";
import { __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { readLocalFileSafely, root } from "../src/root.js";
import { readSecureFile } from "../src/secure-file.js";
import { allowWindowsFilesystemStalls, itPosix, useRealTempDirs } from "./helpers/vitest.js";

allowWindowsFilesystemStalls();
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

const payloadBytes = 65_512;
const content = Buffer.from("0123456789abcdef".repeat(15_706));

function shortReads(handle: fs.FileHandle, observedReads: number[] = []): void {
  const read = handle.read.bind(handle);
  // Model a 9p mount's payload limit and Node's early-returning readFile().
  vi.spyOn(handle, "read").mockImplementation(async (buffer, offset, length, position) => {
    const result = await read(buffer, offset, Math.min(length, payloadBytes), position);
    observedReads.push(result.bytesRead);
    return result;
  });
  vi.spyOn(handle, "readFile").mockImplementation(async () => {
    const buffer = Buffer.alloc(payloadBytes);
    const { bytesRead } = await read(buffer, 0, buffer.length, null);
    return buffer.subarray(0, bytesRead);
  });
}

const readers = [
  { name: "regular file", read: (filePath: string) => readRegularFile({ filePath }) },
  { name: "local file", read: (filePath: string) => readLocalFileSafely({ filePath }) },
  {
    name: "secure file",
    read: (filePath: string) => readSecureFile({
      filePath,
      permissions: { allowInsecure: true },
    }),
  },
  {
    name: "Root file",
    read: async (filePath: string) => (await root(path.dirname(filePath))).read(path.basename(filePath)),
  },
];

describe("nonblocking filesystem short reads", () => {
  it("reads the complete synchronous regular file after short chunks", async () => {
    const directory = await tempRoot("fs-safe-short-read-sync-");
    const filePath = path.join(directory, "input");
    await fs.writeFile(filePath, content);
    const readSync = fsSync.readSync;
    vi.spyOn(fsSync, "readSync").mockImplementation((fd, buffer, offset, length, position) =>
      readSync(fd, buffer, offset, Math.min(length, payloadBytes), position));

    expect(readRegularFileSync({ filePath }).buffer.equals(content)).toBe(true);
  });

  it.each(readers)("reads the complete $name after multiple short chunks", async ({ read }) => {
    const directory = await tempRoot("fs-safe-short-read-");
    const filePath = path.join(directory, "input");
    await fs.writeFile(filePath, content, { mode: 0o600 });
    const open = fs.open.bind(fs);
    const observedReads: number[] = [];
    let opened: fs.FileHandle | undefined;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      if (process.platform !== "win32") {
        expect(Number(args[1]) & fsSync.constants.O_NONBLOCK).toBe(fsSync.constants.O_NONBLOCK);
      }
      const handle = opened = await open(...args);
      shortReads(handle, observedReads);
      return handle;
    });

    const result = await read(filePath);

    expect(result.buffer.equals(content)).toBe(true);
    expect(result.stat.size).toBe(content.length);
    expect(observedReads[0]).toBe(payloadBytes);
    expect(observedReads.at(-1)).toBe(0);
    expect(opened?.fd).toBe(-1);
  });

  it.each(["copy fallback", "content verification"])("preserves complete atomic replacement through %s", async (route) => {
    const directory = await tempRoot("fs-safe-short-replace-");
    const filePath = path.join(directory, "output");
    await fs.writeFile(filePath, "previous");
    await replaceFileAtomic({
      filePath,
      content,
      copyFallbackOnPermissionError: route === "copy fallback",
      renameIdentity: route === "content verification" ? "verify-content-with-lock" : "strict",
      fileSystem: {
        promises: {
          ...fs,
          async open(...args) {
            const handle = await fs.open(...args);
            shortReads(handle);
            return handle;
          },
          async rename(from, to) {
            if (route === "copy fallback") throw Object.assign(new Error("rename denied"), { code: "EPERM" });
            // FUSE-style replacement: identical content with a new inode.
            await fs.copyFile(from, to);
            await fs.unlink(from);
          },
        },
      },
    });

    expect((await fs.readFile(filePath)).equals(content)).toBe(true);
  });

  itPosix("verifies a complete Root staged write after a rename changes identity", async () => {
    const directory = await tempRoot("fs-safe-short-staged-");
    const filePath = path.join(directory, "output");
    configureFsSafeNative({ mode: "off" });
    const files = await root(directory);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      shortReads(handle);
      return handle;
    });
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await fs.copyFile(from, to);
      await fs.unlink(from);
    });

    await files.write("output", content, { renameIdentity: "verify-content-with-lock", durable: false });

    expect((await fs.readFile(filePath)).equals(content)).toBe(true);
  });
});
