import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectFsSafeErrorSync } from "./helpers/security.js";
import * as advanced from "../src/advanced.js";
import {
  readFileDescriptorBounded,
  readFileDescriptorBoundedSync,
  readFileHandleBounded,
} from "../src/bounded-read.js";
import { createMaxBytesTransform } from "../src/bounded-read-stream.js";
import { FsSafeError } from "../src/errors.js";
import { readJson, readJsonSync } from "../src/json.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

const tempDirs = new Set<string>();

async function tempFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-bounded-read-"));
  tempDirs.add(dir);
  const filePath = path.join(dir, "input.txt");
  await fs.writeFile(filePath, content);
  return filePath;
}

afterEach(async () => {
  __setFsSafeTestHooksForTest(undefined);
  await Promise.all(
    [...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  tempDirs.clear();
});

describe("bounded descriptor reads", () => {
  it("rejects a non-finite stream byte cap instead of disabling the bound", () => {
    expect(() => createMaxBytesTransform(Number.NaN)).toThrow(RangeError);
    expect(() => createMaxBytesTransform(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });
  it("exports the descriptor and handle primitives from the advanced surface", () => {
    expect(advanced.readFileDescriptorBounded).toBe(readFileDescriptorBounded);
    expect(advanced.readFileDescriptorBoundedSync).toBe(readFileDescriptorBoundedSync);
    expect(advanced.readFileHandleBounded).toBe(readFileHandleBounded);
  });

  it("reads an exact-size file and leaves a sync descriptor open", async () => {
    const filePath = await tempFile("abcd");
    const fd = fsSync.openSync(filePath, "r");
    try {
      expect(readFileDescriptorBoundedSync(fd, 4).toString("utf8")).toBe("abcd");
      expect(fsSync.fstatSync(fd).isFile()).toBe(true);
    } finally {
      fsSync.closeSync(fd);
    }
  });

  it("consumes only maxBytes + 1 before rejecting a sync descriptor", async () => {
    const filePath = await tempFile("abcdef");
    const fd = fsSync.openSync(filePath, "r");
    try {
      expectFsSafeErrorSync(() => readFileDescriptorBoundedSync(fd, 2), "too-large");
      const next = Buffer.alloc(1);
      expect(fsSync.readSync(fd, next, 0, 1, null)).toBe(1);
      expect(next.toString("utf8")).toBe("d");
    } finally {
      fsSync.closeSync(fd);
    }
  });

  it("reads numeric descriptors asynchronously without taking ownership", async () => {
    const filePath = await tempFile("abcd");
    const fd = fsSync.openSync(filePath, "r");
    try {
      await expect(readFileDescriptorBounded(fd, 4)).resolves.toEqual(Buffer.from("abcd"));
      expect(fsSync.fstatSync(fd).isFile()).toBe(true);
    } finally {
      fsSync.closeSync(fd);
    }
  });

  it("rejects handle growth beyond the stat-time budget without buffering the file", async () => {
    const filePath = await tempFile("abcd");
    const handle = await fs.open(filePath, "r");
    try {
      expect((await handle.stat()).size).toBe(4);
      await fs.appendFile(filePath, "efghijkl");
      await expect(readFileHandleBounded(handle, 4)).rejects.toMatchObject({
        constructor: FsSafeError,
        code: "too-large",
      });
    } finally {
      await handle.close();
    }
  });

  it("keeps Root reads bounded when a file grows after the verified open", async () => {
    const filePath = await tempFile("abcd");
    const scoped = await root(path.dirname(filePath), { maxBytes: 4 });
    __setFsSafeTestHooksForTest({
      afterOpen(_openedPath, handle) {
        const originalRead = handle.read.bind(handle);
        let grown = false;
        Object.defineProperty(handle, "read", {
          configurable: true,
          value: async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number | null,
          ) => {
            if (!grown) {
              grown = true;
              fsSync.appendFileSync(filePath, "efghijkl");
            }
            return await originalRead(buffer, offset, length, position);
          },
        });
      },
    });

    await expect(scoped.read("input.txt")).rejects.toMatchObject({ code: "too-large" });
  });

  it("applies maxBytes to standalone async and sync JSON readers", async () => {
    const filePath = await tempFile(JSON.stringify({ value: "large" }));
    const asyncError = await readJson(filePath, { maxBytes: 4 }).catch((error) => error);
    expect(asyncError).toMatchObject({ reason: "read" });
    expect((asyncError as Error).cause).toMatchObject({ code: "too-large" });

    let syncError: unknown;
    try {
      readJsonSync(filePath, { maxBytes: 4 });
    } catch (error) {
      syncError = error;
    }
    expect(syncError).toMatchObject({ reason: "read" });
    expect((syncError as Error).cause).toMatchObject({ code: "too-large" });
  });

  it("supports zero-byte and explicitly unbounded reads", async () => {
    const emptyPath = await tempFile("");
    const empty = await fs.open(emptyPath, "r");
    try {
      await expect(readFileHandleBounded(empty, 0)).resolves.toEqual(Buffer.alloc(0));
    } finally {
      await empty.close();
    }

    const contentPath = await tempFile("content");
    const content = await fs.open(contentPath, "r");
    try {
      await expect(readFileHandleBounded(content, Number.POSITIVE_INFINITY)).resolves.toEqual(
        Buffer.from("content"),
      );
    } finally {
      await content.close();
    }
  });

  it.each([-1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY])(
    "rejects invalid maxBytes value %s",
    async (maxBytes) => {
      const filePath = await tempFile("x");
      const fd = fsSync.openSync(filePath, "r");
      try {
        expect(() => readFileDescriptorBoundedSync(fd, maxBytes)).toThrow(RangeError);
      } finally {
        fsSync.closeSync(fd);
      }
    },
  );
});
