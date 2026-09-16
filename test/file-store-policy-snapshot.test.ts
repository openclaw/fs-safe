import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileStore, fileStoreSync, type FileStoreWriteOptions } from "../src/file-store.js";
import * as copySource from "../src/file-store-copy-source.js";
import * as boundary from "../src/file-store-boundary.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function observeSyncs(directory: string) {
  const probe = await fs.open(path.join(directory, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  await fs.unlink(path.join(directory, "probe"));
  const sync = vi.spyOn(prototype, "sync");
  const syncSync = vi.spyOn(fsSync, "fsyncSync");
  return () => sync.mock.calls.length + syncSync.mock.calls.length;
}

function mutablePolicy() {
  const values = { maxBytes: 100, durable: false, dirMode: 0o700, mode: 0o600, trailingNewline: false };
  const reads = { maxBytes: 0, durable: 0, dirMode: 0, mode: 0, trailingNewline: 0, tempPrefix: 0 };
  let options: FileStoreWriteOptions & { trailingNewline?: boolean };
  const accessors = Object.defineProperties({}, Object.fromEntries(
    Object.keys(values).map((name) => {
      const key = name as keyof typeof values;
      return [key, { get(this: unknown) {
        expect(this).toBe(options);
        reads[key]++;
        return values[key];
      } }];
    }),
  ));
  options = Object.create(accessors) as typeof options;
  Object.defineProperties(options, {
    tempPrefix: { get() { reads.tempPrefix++; return "snapshot"; } },
    unused: { enumerable: true, get() { throw new Error("unused getter"); } },
  });
  const mutate = () => {
    values.maxBytes = 1;
    values.durable = true;
    values.dirMode = 0o755;
    values.mode = 0o644;
    values.trailingNewline = true;
  };
  return { options, reads, mutate };
}

async function expectPublished(rootDir: string, expected: string, syncs: () => number) {
  const target = path.join(rootDir, "nested/target");
  expect(await fs.readFile(target, "utf8")).toBe(expected);
  expect(syncs()).toBe(0);
  if (process.platform !== "win32") {
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(target))).mode & 0o777).toBe(0o700);
  }
}

describe.each([false, true])("FileStore policy snapshot (private=%s)", privateMode => {
  it.each(["write", "writeText"] as const)("preserves %s conversion errors before policy access", async method => {
    const rootDir = await tempRoot("fs-safe-conversion-order-");
    const failure = new Error("conversion first");
    const events: string[] = [];
    const data = { valueOf() { events.push("convert"); throw failure; } } as unknown as Uint8Array;
    const options = { get maxBytes(): never { events.push("maxBytes"); throw new Error("policy"); } };
    await expect(fileStore({ rootDir, private: privateMode })[method]("target", data, options)).rejects.toBe(failure);
    expect(events).toEqual(["convert"]);
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it.each(["write", "writeText"] as const)("preserves %s policy order after content conversion", async method => {
    const rootDir = await tempRoot("fs-safe-write-getter-order-");
    const failure = new Error("last getter");
    const events: string[] = [];
    const data = { valueOf() { events.push("convert"); return "ok"; } } as unknown as Uint8Array;
    const options = {
      get maxBytes() { events.push("maxBytes"); return 100; },
      get dirMode() { events.push("dirMode"); return 0o700; },
      get mode() { events.push("mode"); if (privateMode) throw failure; return 0o600; },
      get durable() { events.push("durable"); if (!privateMode) throw failure; return false; },
    };
    await expect(fileStore({ rootDir, private: privateMode })[method]("target", data, options)).rejects.toBe(failure);
    expect(events).toEqual(["convert", "maxBytes", ...(privateMode
      ? ["durable", "dirMode", "mode"] : ["dirMode", "mode", "durable"])]);
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it.each(["write", "writeText", "writeStream", "copyIn"] as const)("normalizes %s limits before other getters", async method => {
    const rootDir = await tempRoot("fs-safe-invalid-limit-order-");
    const events: string[] = [];
    const options = {
      get maxBytes() { events.push("maxBytes"); return -1; },
      get durable(): never { events.push("durable"); throw new Error("unused durable"); },
      get dirMode(): never { events.push("dirMode"); throw new Error("unused dirMode"); },
      get mode(): never { events.push("mode"); throw new Error("unused mode"); },
      get tempPrefix(): never { events.push("tempPrefix"); throw new Error("unused prefix"); },
    };
    const store = fileStore({ rootDir, private: privateMode });
    const stream = Readable.from(["payload"]);
    try {
      const pending = method === "writeStream" ? store.writeStream("target", stream, options)
        : method === "copyIn" ? store.copyIn("target", path.join(rootDir, "missing"), options)
        : store[method]("target", "payload", options);
      await expect(pending).rejects.toBeInstanceOf(RangeError);
      expect(events).toEqual(["maxBytes"]);
      expect(await fs.readdir(rootDir)).toEqual([]);
    } finally {
      stream.destroy();
    }
  });

  it.each(["write", "writeText"] as const)("preserves %s too-large errors before later policy getters", async method => {
    const rootDir = await tempRoot("fs-safe-size-error-order-");
    const reads = vi.fn(() => { throw new Error("unused policy"); });
    const options = Object.defineProperties({ maxBytes: 1 }, {
      durable: { get: reads }, dirMode: { get: reads }, mode: { get: reads },
    });
    await expect(fileStore({ rootDir, private: privateMode })[method]("target", "payload", options)).rejects.toMatchObject({ code: "too-large" });
    expect(reads).not.toHaveBeenCalled();
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it.each([false, true])("captures JSON getters in branch order without early normalization (sync=%s)", async synchronous => {
    const rootDir = await tempRoot("fs-safe-json-getter-order-");
    const events: string[] = [];
    const failure = new Error("serialization before limit validation");
    const options = {
      get trailingNewline() { events.push("trailingNewline"); return false; },
      get maxBytes() { events.push("maxBytes"); return -1; },
      get durable() { events.push("durable"); return false; },
      get dirMode() { events.push("dirMode"); return 0o700; },
      get mode() { events.push("mode"); return 0o600; },
    };
    const value = { toJSON() { events.push("serialize"); throw failure; } };
    const store = (synchronous ? fileStoreSync : fileStore)({ rootDir, private: privateMode });
    await expect((async () => store.writeJson("target", value, options))()).rejects.toBe(failure);
    expect(events).toEqual(["trailingNewline", "maxBytes", ...(synchronous || privateMode
      ? ["durable", "dirMode", "mode"] : ["dirMode", "mode", "durable"]), "serialize"]);
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it.each(["write", "writeText"] as const)("captures %s before yielding", async method => {
    const rootDir = await tempRoot("fs-safe-store-snapshot-");
    const syncs = await observeSyncs(rootDir);
    const policy = mutablePolicy();
    const pending = fileStore({ rootDir, private: privateMode })[method]("nested/target", "payload", policy.options);
    policy.mutate();
    await pending;
    await expectPublished(rootDir, "payload", syncs);
    expect(policy.reads).toEqual({ maxBytes: 1, durable: 1, dirMode: 1, mode: 1, trailingNewline: 0, tempPrefix: 0 });
  });

  it("captures stream policy before iteration and uses one mode for staging/publication", async () => {
    const rootDir = await tempRoot("fs-safe-stream-snapshot-");
    const syncs = await observeSyncs(rootDir);
    const policy = mutablePolicy();
    let iterations = 0;
    const stream = Readable.from((async function* () {
      iterations++;
      policy.mutate();
      yield "pay";
      yield "load";
    })());
    await fileStore({ rootDir, private: privateMode }).writeStream("nested/target", stream, policy.options);
    expect(iterations).toBe(1);
    await expectPublished(rootDir, "payload", syncs);
    expect(policy.reads).toEqual({ maxBytes: 1, durable: 1, dirMode: 1, mode: 1, trailingNewline: 0, tempPrefix: privateMode ? 0 : 1 });
  });

  it("captures copy policy before source work and never rereads caller limits", async () => {
    const rootDir = await tempRoot("fs-safe-copy-snapshot-");
    const source = path.join(rootDir, "source");
    await fs.writeFile(source, "payload");
    const syncs = await observeSyncs(rootDir);
    const policy = mutablePolicy();
    const readSource = copySource.readFileStoreCopySource;
    const sourceRead = vi.spyOn(copySource, "readFileStoreCopySource").mockImplementation(params => {
      policy.mutate();
      return readSource(params);
    });
    const pending = fileStore({ rootDir, private: privateMode }).copyIn("nested/target", source, policy.options);
    policy.mutate();
    await pending;
    expect(sourceRead).toHaveBeenCalledTimes(privateMode ? 1 : 0);
    await expectPublished(rootDir, "payload", syncs);
    expect(policy.reads).toEqual({ maxBytes: 1, durable: 1, dirMode: 1, mode: 1, trailingNewline: 0, tempPrefix: privateMode ? 0 : 1 });
  });

  it.each([false, true])("captures all JSON policy before one serialization (sync=%s)", async synchronous => {
    const rootDir = await tempRoot("fs-safe-json-snapshot-");
    const syncs = await observeSyncs(rootDir);
    const policy = mutablePolicy();
    let serializations = 0;
    const value = { toJSON(this: unknown) {
      expect(this).toBe(value);
      serializations++;
      policy.mutate();
      return { ok: true };
    } };
    const store = (synchronous ? fileStoreSync : fileStore)({ rootDir, private: privateMode });
    await store.writeJson("nested/target", value, policy.options);
    expect(serializations).toBe(1);
    await expectPublished(rootDir, '{\n  "ok": true\n}', syncs);
    expect(policy.reads).toEqual({ maxBytes: 1, durable: 1, dirMode: 1, mode: 1, trailingNewline: 1, tempPrefix: 0 });
  });

  it.each([false, true])("keeps the captured JSON byte limit (sync=%s)", async synchronous => {
    const rootDir = await tempRoot("fs-safe-json-limit-snapshot-");
    const options = { maxBytes: 1 };
    const value = { toJSON() { options.maxBytes = 100; return { ok: true }; } };
    const store = (synchronous ? fileStoreSync : fileStore)({ rootDir, private: privateMode });
    await expect((async () => store.writeJson("target", value, options))()).rejects.toMatchObject({ code: "too-large" });
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it("retains bound JSON policy through locking and serialization", async () => {
    const rootDir = await tempRoot("fs-safe-bound-json-policy-");
    const options = { durable: false, trailingNewline: false, lock: true };
    let serializations = 0;
    const value = { toJSON(this: unknown) {
      expect(this).toBe(value);
      serializations++;
      options.durable = true;
      options.trailingNewline = true;
      return { ok: true };
    } };
    const store = fileStore({ rootDir, private: privateMode }).json("nested/target", options);
    await store.write(value);
    expect(serializations).toBe(1);
    expect(await fs.readFile(path.join(rootDir, "nested/target"), "utf8")).toBe('{\n  "ok": true\n}');
  });

  it("preserves serialization and private source errors before invalid destination keys", async () => {
    const rootDir = await tempRoot("fs-safe-policy-order-");
    const failure = new Error("serialization first");
    const options = { durable: false, maxBytes: 100 };
    const value = { toJSON() { options.maxBytes = 1; throw failure; } };
    const store = fileStore({ rootDir, private: privateMode });
    await expect(store.writeJson("../target", value, options)).rejects.toBe(failure);
    expect(() => fileStoreSync({ rootDir, private: privateMode }).writeJson("../target", value, options)).toThrow(failure);
    await expect(store.copyIn("../target", path.join(rootDir, "missing"), options)).rejects.toMatchObject({
      code: privateMode ? "ENOENT" : "invalid-path",
    });
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it("does not inspect unsupported options on plain/private writes", async () => {
    const rootDir = await tempRoot("fs-safe-unused-policy-");
    const options = {
      durable: false,
      get trailingNewline(): never { throw new Error("unused newline"); },
      get tempPrefix(): never { throw new Error("unused prefix"); },
    };
    const store = fileStore({ rootDir, private: privateMode });
    await store.write("target", "payload", options);
    if (privateMode) {
      await store.writeStream("target", Readable.from(["payload"]), options);
      await store.copyIn("copy", path.join(rootDir, "target"), options);
    }
    expect(await fs.readFile(path.join(rootDir, "target"), "utf8")).toBe("payload");
  });
});

describe("non-private stream tempPrefix access ordering", () => {
  it.each(["stream-error", "too-large"] as const)("preserves %s before the prefix getter", async outcome => {
    const rootDir = await tempRoot("fs-safe-stream-prefix-order-");
    const failure = new Error("source failure");
    const getPrefix = vi.fn(() => { throw new Error("unused prefix"); });
    const options = Object.defineProperty({ durable: false, maxBytes: 1 }, "tempPrefix", { get: getPrefix });
    const stream = Readable.from((async function* () {
      if (outcome === "stream-error") throw failure;
      yield "payload";
    })());
    const pending = fileStore({ rootDir }).writeStream("target", stream, options);
    if (outcome === "stream-error") await expect(pending).rejects.toBe(failure);
    else await expect(pending).rejects.toMatchObject({ code: "too-large" });
    expect(getPrefix).not.toHaveBeenCalled();
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it("reads the prefix once after staging and cleans up when its getter throws", async () => {
    const rootDir = await tempRoot("fs-safe-stream-prefix-cleanup-");
    const failure = new Error("prefix after staging");
    const events: string[] = [];
    const stage = boundary.writeStreamToTempSource;
    let stagedPath: string | undefined;
    vi.spyOn(boundary, "writeStreamToTempSource").mockImplementation(async params => {
      const staged = await stage(params);
      stagedPath = staged.path;
      events.push("staged");
      return { path: staged.path, cleanup: async () => { events.push("cleanup"); await staged.cleanup(); } };
    });
    const options = {
      durable: false,
      get tempPrefix(): never { expect(this).toBe(options); events.push("tempPrefix"); throw failure; },
    };
    const stream = Readable.from((async function* () { events.push("stream"); yield "payload"; })());
    await expect(fileStore({ rootDir }).writeStream("target", stream, options)).rejects.toBe(failure);
    expect(events).toEqual(["stream", "staged", "tempPrefix", "cleanup"]);
    expect(stagedPath).toBeDefined();
    await expect(fs.lstat(stagedPath!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(rootDir)).toEqual([]);
  });
});
