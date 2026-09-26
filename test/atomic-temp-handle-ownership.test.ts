import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  replaceFileAtomic, replaceFileAtomicSync,
  type ReplaceFileAtomicDestinationState, type ReplaceFileAtomicFileSystem,
} from "../src/replace-file.js";
import { sha256Hex } from "../src/file-identity.js";
import { AsyncAtomicTempOwner } from "../src/replace-file-temp-owner.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const CLOSE_FAILURES = [
  { label: "Error", failure: new Error("close released then rejected") },
  { label: "undefined", failure: undefined },
  { label: "null", failure: null },
] as const;

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

describe("atomic temp handle ownership", () => {
  it.each(CLOSE_FAILURES)("consumes the previous handle before a rejected publication close ($label)", async ({ failure: closeFailure }) => {
    const directory = await tempRoot("fs-safe-atomic-published-close-owner-");
    const tempPath = path.join(directory, "owned-temp");
    const publishedPath = path.join(directory, "published");
    const content = "replacement";
    await fs.writeFile(tempPath, content);
    await fs.writeFile(publishedPath, content);

    const previous = await fs.open(tempPath, "r+");
    const previousIdentity = await previous.stat({ bigint: true });
    const previousFd = previous.fd;
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

  it.each(CLOSE_FAILURES)("consumes the terminal handle before awaiting a rejected close ($label)", async ({ failure: closeFailure }) => {
    const directory = await tempRoot("fs-safe-atomic-finish-close-owner-");
    const tempPath = path.join(directory, "owned-temp");
    await fs.writeFile(tempPath, "temporary");
    const handle = await fs.open(tempPath, "r+");
    const identity = await handle.stat({ bigint: true });
    const fd = handle.fd;
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

  it.each(CLOSE_FAILURES.flatMap(failure => [false, true].map(synchronous => ({ ...failure, synchronous }))))(
    "retains the publication receipt and closes adopted handles once ($label, sync=$synchronous)", async ({ failure: closeFailure, synchronous }) => {
    const directory = await tempRoot("fs-safe-atomic-published-close-public-");
    const target = path.join(directory, "target");
    const content = "replacement";
    const open = fs.open.bind(fs);
    let tempCloses = 0;
    let publishedCloses = 0;
    let tempFd: number | undefined;
    let publishedFd: number | undefined;
    let publishedIdentity: fsSync.BigIntStats | undefined;
    const receipts: ReplaceFileAtomicDestinationState[] = [];

    const adapterOpen: typeof fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[1] === "wx") {
        tempFd = handle.fd;
        rejectCloseAfterRelease(handle, closeFailure, () => { tempCloses += 1; });
      } else if (String(args[0]) === target) {
        publishedFd = handle.fd;
        publishedIdentity = fsSync.fstatSync(handle.fd, { bigint: true });
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

    const options = {
      filePath: target,
      content,
      renameIdentity: "verify-content-with-lock" as const,
      onDestinationState: (receipt: ReplaceFileAtomicDestinationState) => { receipts.push(receipt); },
    };
    const run = async () => {
      if (!synchronous) return await replaceFileAtomic({ ...options, fileSystem });
      return replaceFileAtomicSync({ ...options, fileSystem: {
        ...fsSync,
        openSync(candidate, flags, mode) {
          const fd = fsSync.openSync(candidate, flags, mode);
          if (flags === "wx") tempFd = fd;
          else if (String(candidate) === target) {
            publishedFd = fd;
            publishedIdentity = fsSync.fstatSync(fd, { bigint: true });
          }
          return fd;
        },
        closeSync(fd) {
          fsSync.closeSync(fd);
          if (fd === tempFd) { tempCloses++; throw closeFailure; }
          if (fd === publishedFd) publishedCloses++;
        },
        renameSync(from, to) {
          fsSync.copyFileSync(from, to);
          fsSync.unlinkSync(from);
        },
      } });
    };
    await expect(run()).rejects.toBe(closeFailure);

    expect(tempCloses).toBe(1);
    expect(publishedCloses).toBe(1);
    expectClosed(tempFd!);
    expectClosed(publishedFd!);
    await expect(fs.readFile(target, "utf8")).resolves.toBe(content);
    expect(receipts).toEqual([{
      state: "published", path: target, dev: publishedIdentity!.dev, ino: publishedIdentity!.ino,
    }]);
    expect((await fs.readdir(directory)).filter((name) => name.startsWith(".fs-safe-replace.")))
      .toEqual([]);
  });
});
