import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeMaxBytes } from "../src/byte-budget.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import { readJsonDurableQueueEntry } from "../src/json-durable-queue.js";
import { writeExternalFileWithinRoot } from "../src/output.js";
import { readRegularFile } from "../src/regular-file.js";
import { root } from "../src/root.js";
import { readSecureFile } from "../src/secure-file.js";
import { readSecretFile } from "../src/secret-read-async.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

const invalidLimits = [Number.NaN, -1, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1];

describe("byte budget normalization", () => {
  it.each(invalidLimits)("rejects invalid maxBytes %s", (maxBytes) => {
    expect(() => normalizeMaxBytes(maxBytes)).toThrow(
      "maxBytes must be a non-negative safe integer or Infinity",
    );
  });

  it("preserves undefined defaults, explicit zero, and positive Infinity", () => {
    expect(normalizeMaxBytes(undefined)).toBeUndefined();
    expect(normalizeMaxBytes(undefined, { defaultValue: 7 })).toBe(7);
    expect(normalizeMaxBytes(0, { defaultValue: 7 })).toBe(0);
    expect(normalizeMaxBytes(Number.POSITIVE_INFINITY, { defaultValue: 7 }))
      .toBe(Number.POSITIVE_INFINITY);
  });

  it("preserves Root defaults when per-call maxBytes is explicitly undefined", async () => {
    const rootDir = await tempRoot("fs-safe-root-budget-default-");
    await fs.writeFile(path.join(rootDir, "value"), "ab");
    const scoped = await root(rootDir, { maxBytes: 1 });

    await expect(scoped.read("value", { maxBytes: undefined })).rejects.toMatchObject({
      code: "too-large",
    });
    await expect(scoped.read("value", { maxBytes: Number.POSITIVE_INFINITY }))
      .resolves.toMatchObject({ buffer: Buffer.from("ab") });
  });

  it("preserves Root copy defaults and explicit zero", async () => {
    const rootDir = await tempRoot("fs-safe-root-budget-copy-");
    const source = path.join(rootDir, "source");
    await fs.writeFile(source, "ab");
    const scoped = await root(rootDir, { maxBytes: 1 });

    await expect(scoped.copyIn("too-large", source, { maxBytes: undefined }))
      .rejects.toMatchObject({ code: "too-large" });
    await expect(scoped.copyIn("unlimited", source, { maxBytes: Number.POSITIVE_INFINITY }))
      .resolves.toBeUndefined();
    await fs.writeFile(source, "");
    await expect(scoped.copyIn("empty", source, { maxBytes: 0 })).resolves.toBeUndefined();
  });

  it("rejects invalid Root defaults and per-call limits before opening a file", async () => {
    const parent = await tempRoot("fs-safe-root-budget-invalid-");
    const missingRoot = path.join(parent, "missing");
    await expect(root(missingRoot, { maxBytes: Number.NaN })).rejects.toBeInstanceOf(RangeError);
    await expect(fs.lstat(missingRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const filePath = path.join(parent, "value");
    await fs.writeFile(filePath, "value");
    const scoped = await root(parent);
    const open = vi.spyOn(fs, "open");
    await expect(scoped.read("value", { maxBytes: -1 })).rejects.toBeInstanceOf(RangeError);
    expect(open).not.toHaveBeenCalled();
  });

  it("normalizes FileStore buffer, stream, copy, and sync limits", async () => {
    const rootDir = await tempRoot("fs-safe-store-budget-");
    const source = path.join(rootDir, "source");
    await fs.writeFile(source, "ab");
    const store = fileStore({ rootDir: path.join(rootDir, "async"), maxBytes: 1 });

    await expect(store.write("buffer", "ab", { maxBytes: undefined }))
      .rejects.toMatchObject({ code: "too-large" });
    await expect(store.write("unlimited", "ab", { maxBytes: Number.POSITIVE_INFINITY }))
      .resolves.toBeDefined();
    await expect(store.readText("unlimited", { maxBytes: undefined }))
      .rejects.toMatchObject({ code: "too-large" });
    await expect(store.readText("unlimited", { maxBytes: Number.POSITIVE_INFINITY }))
      .resolves.toBe("ab");
    await expect(store.writeStream("stream", Readable.from(["a", "b"]), { maxBytes: undefined }))
      .rejects.toMatchObject({ code: "too-large" });
    await expect(store.writeStream("stream-unlimited", Readable.from(["a", "b"]), {
      maxBytes: Number.POSITIVE_INFINITY,
    })).resolves.toBeDefined();
    await expect(store.copyIn("copy", source, { maxBytes: undefined }))
      .rejects.toMatchObject({ code: "too-large" });
    await expect(store.copyIn("copy-unlimited", source, { maxBytes: Number.POSITIVE_INFINITY }))
      .resolves.toBeDefined();
    await expect(store.write("empty", "", { maxBytes: 0 })).resolves.toBeDefined();

    const sync = fileStoreSync({ rootDir: path.join(rootDir, "sync"), maxBytes: 1 });
    expect(() => sync.write("buffer", "ab", { maxBytes: undefined }))
      .toThrow(expect.objectContaining({ code: "too-large" }));
    expect(sync.write("unlimited", "ab", { maxBytes: Number.POSITIVE_INFINITY }))
      .toBeDefined();
    expect(() => sync.readTextIfExists("unlimited", { maxBytes: undefined }))
      .toThrow(expect.objectContaining({ code: "too-large" }));
    expect(sync.readTextIfExists("unlimited", { maxBytes: Number.POSITIVE_INFINITY }))
      .toBe("ab");
  });

  it("rejects invalid FileStore stream and copy overrides before consuming input", async () => {
    const rootDir = await tempRoot("fs-safe-store-budget-override-");
    const source = path.join(rootDir, "source");
    await fs.writeFile(source, "source");
    const store = fileStore({ rootDir: path.join(rootDir, "store") });
    let consumed = false;
    const stream = Readable.from((async function* () {
      consumed = true;
      yield "value";
    })());

    await expect(store.writeStream("stream", stream, { maxBytes: Number.NaN }))
      .rejects.toBeInstanceOf(RangeError);
    expect(consumed).toBe(false);
    await expect(store.copyIn("copy", source, { maxBytes: -1 }))
      .rejects.toBeInstanceOf(RangeError);
  });

  it.each(invalidLimits)("rejects FileStore maxBytes %s before creating its root", async (maxBytes) => {
    const parent = await tempRoot("fs-safe-store-budget-invalid-");
    const rootDir = path.join(parent, "store");
    expect(() => fileStore({ rootDir, maxBytes })).toThrow(RangeError);
    expect(() => fileStoreSync({ rootDir, maxBytes })).toThrow(RangeError);
    await expect(fs.lstat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid related read and write limits before filesystem admission", async () => {
    const rootDir = await tempRoot("fs-safe-related-budget-");
    const filePath = path.join(rootDir, "value");
    await fs.writeFile(filePath, "value", { mode: 0o600 });
    const open = vi.spyOn(fs, "open");

    await expect(readRegularFile({ filePath, maxBytes: Number.NaN })).rejects.toBeInstanceOf(RangeError);
    await expect(readSecureFile({ filePath, io: { maxBytes: -1 } })).rejects.toBeInstanceOf(RangeError);
    await expect(readSecretFile(filePath, "token", { maxBytes: 1.5 })).rejects.toBeInstanceOf(RangeError);
    await expect(readJsonDurableQueueEntry(filePath, { maxBytes: Number.NaN }))
      .rejects.toBeInstanceOf(RangeError);
    await expect(writeExternalFileWithinRoot({
      rootDir,
      path: "output",
      maxBytes: -1,
      write: async () => undefined,
    })).rejects.toBeInstanceOf(RangeError);
    expect(open).not.toHaveBeenCalled();
  });
});
