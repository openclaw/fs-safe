import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomic, type ReplaceFileAtomicFileSystem } from "../src/replace-file.js";
import { sha256Hex } from "../src/file-identity.js";
import { AsyncAtomicTempOwner } from "../src/replace-file-temp-owner.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

function rejectCloseAfterRelease(
  handle: FileHandle,
  failure: unknown,
  onClose: () => void,
): void {
  const close = handle.close.bind(handle);
  handle.close = async () => {
    onClose();
    await close();
    throw failure;
  };
}

function countClose(handle: FileHandle, onClose: () => void): void {
  const close = handle.close.bind(handle);
  handle.close = async () => {
    onClose();
    await close();
  };
}

function expectClosed(fd: number): void {
  expect(() => fsSync.fstatSync(fd)).toThrow();
}

describe("async atomic temp handle ownership", () => {
  it("consumes the previous handle before a rejected publication close", async () => {
    const directory = await tempRoot("fs-safe-atomic-published-close-owner-");
    const tempPath = path.join(directory, "owned-temp");
    const publishedPath = path.join(directory, "published");
    const content = "replacement";
    await fs.writeFile(tempPath, content);
    await fs.writeFile(publishedPath, content);

    const previous = await fs.open(tempPath, "r+");
    const previousIdentity = await previous.stat({ bigint: true });
    const previousFd = previous.fd;
    const closeFailure = new Error("previous close released then rejected");
    let previousCloses = 0;
    let publishedCloses = 0;
    let publishedFd: number | undefined;
    rejectCloseAfterRelease(previous, closeFailure, () => { previousCloses += 1; });

    const owner = new AsyncAtomicTempOwner(tempPath);
    owner.start();
    owner.adopt({ handle: previous, identity: previousIdentity });
    owner.markRenamed();
    const adapter: Pick<typeof fs, "lstat" | "open" | "unlink"> = {
      lstat: fs.lstat,
      unlink: fs.unlink,
      open: async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        publishedFd = handle.fd;
        countClose(handle, () => { publishedCloses += 1; });
        return handle;
      },
    };

    await expect(owner.assertPublished(adapter, publishedPath, sha256Hex(content)))
      .rejects.toBe(closeFailure);
    await expect(owner.finish({
      fsModule: adapter,
      throwOnCleanupError: true,
    })).resolves.toBeUndefined();
    await expect(owner.finish({
      fsModule: adapter,
      throwOnCleanupError: true,
    })).resolves.toBeUndefined();

    expect(previousCloses).toBe(1);
    expect(publishedCloses).toBe(1);
    expectClosed(previousFd);
    expectClosed(publishedFd!);
    await expect(fs.readFile(publishedPath, "utf8")).resolves.toBe(content);
  });

  it("consumes the terminal handle before awaiting a rejected close", async () => {
    const directory = await tempRoot("fs-safe-atomic-finish-close-owner-");
    const tempPath = path.join(directory, "owned-temp");
    await fs.writeFile(tempPath, "temporary");
    const handle = await fs.open(tempPath, "r+");
    const identity = await handle.stat({ bigint: true });
    const fd = handle.fd;
    const closeFailure = new Error("finish close released then rejected");
    let closes = 0;
    rejectCloseAfterRelease(handle, closeFailure, () => { closes += 1; });

    const owner = new AsyncAtomicTempOwner(tempPath);
    owner.adopt({ handle, identity });
    const adapter: Pick<typeof fs, "lstat" | "open" | "unlink"> = {
      lstat: fs.lstat,
      open: fs.open,
      unlink: fs.unlink,
    };

    await expect(owner.finish({
      fsModule: adapter,
      throwOnCleanupError: true,
    })).rejects.toBe(closeFailure);
    await expect(owner.finish({
      fsModule: adapter,
      throwOnCleanupError: true,
    })).resolves.toBeUndefined();

    expect(closes).toBe(1);
    expectClosed(fd);
  });

  it("does not retry an adapter handle after public publication adopts a new inode", async () => {
    const directory = await tempRoot("fs-safe-atomic-published-close-public-");
    const target = path.join(directory, "target");
    const content = "replacement";
    const closeFailure = new Error("public temp close released then rejected");
    const open = fs.open.bind(fs);
    let tempCloses = 0;
    let publishedCloses = 0;
    let tempFd: number | undefined;
    let publishedFd: number | undefined;

    const adapterOpen: typeof fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[1] === "wx") {
        tempFd = handle.fd;
        rejectCloseAfterRelease(handle, closeFailure, () => { tempCloses += 1; });
      } else if (String(args[0]) === target) {
        publishedFd = handle.fd;
        countClose(handle, () => { publishedCloses += 1; });
      }
      return handle;
    };
    const fileSystem: ReplaceFileAtomicFileSystem = {
      promises: {
        ...fs,
        open: adapterOpen,
        rename: async (from, to) => {
          await fs.copyFile(from, to);
          await fs.unlink(from);
        },
      },
    };

    await expect(replaceFileAtomic({
      filePath: target,
      content,
      fileSystem,
      renameIdentity: "verify-content-with-lock",
    })).rejects.toBe(closeFailure);

    expect(tempCloses).toBe(1);
    expect(publishedCloses).toBe(1);
    expectClosed(tempFd!);
    expectClosed(publishedFd!);
    await expect(fs.readFile(target, "utf8")).resolves.toBe(content);
    expect((await fs.readdir(directory)).filter((name) => name.startsWith(".fs-safe-replace.")))
      .toEqual([]);
  });
});
