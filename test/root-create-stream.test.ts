import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let nativeAvailable = false;
try {
  __loadBundledNativeForTest();
  nativeAvailable = true;
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}
const modes = nativeAvailable ? ["off", "require"] as const : ["off"] as const;
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
});

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}

describe.each(modes)("streamed Root.create (native %s)", (mode) => {
  async function workspace(defaults: Parameters<typeof root>[1] = {}) {
    configureFsSafeNative({ mode });
    return await root(await tempRoot("fs-safe-create-stream-"), defaults);
  }

  it("publishes complete bytes only after the producer finishes and preserves the requested mode", async () => {
    const capability = await workspace({ durable: false });
    const target = path.join(capability.rootReal, "nested/file");
    async function* input() {
      yield new Uint8Array([0, 1, 2]);
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      yield Buffer.from("complete");
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await capability.create("nested/file", input(), { mode: 0o640 });
    expect(await fs.readFile(target)).toEqual(Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("complete")]));
    if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o640);
    expect((await fs.stat(target)).nlink).toBe(1);
    expect(await fs.readdir(path.dirname(target))).toEqual(["file"]);
  });

  it.each([2, 3])("bounds a reused Uint8Array view by intrinsic bytes at cap %s", async maxBytes => {
    const capability = await workspace({ durable: false });
    const backing = new Uint8Array([90, 1, 2, 3, 91]);
    const chunk = new Uint8Array(backing.buffer, 1, 3);
    Object.defineProperties(chunk, {
      length: { value: 0 }, byteLength: { value: NaN },
      buffer: { get() { throw new Error("shadowed buffer"); } },
    });
    let closed = false;
    async function* input() { try { yield chunk; } finally { closed = true; } }
    const pending = capability.create("file", input(), { maxBytes });
    if (maxBytes === 2) {
      await expect(pending).rejects.toMatchObject({ code: "too-large" });
      expect(await fs.readdir(capability.rootReal)).toEqual([]);
    } else {
      await pending;
      expect(await fs.readFile(path.join(capability.rootReal, "file"))).toEqual(Buffer.from([1, 2, 3]));
    }
    expect(closed).toBe(true);
  });

  it.each(["existing", "competing"])("preserves a %s destination", async (scenario) => {
    const capability = await workspace();
    const target = path.join(capability.rootReal, "file");
    let consumed = false;
    if (scenario === "existing") await fs.writeFile(target, "winner");
    async function* input() {
      consumed = true;
      yield Buffer.from("replacement");
      await fs.writeFile(target, "winner", { flag: "wx" });
    }
    const indeterminate = scenario === "competing";
    await expect(capability.create("file", input())).rejects.toMatchObject(indeterminate && mode === "require" && process.platform !== "win32" ? {
      cause: {
        name: "SuppressedError",
        error: { code: "not-removable", details: { publication: { status: "indeterminate" } } },
        suppressed: { code: "already-exists", details: { publication: { status: "indeterminate" } } },
      },
    } : indeterminate ? {
      code: "already-exists",
      details: { publication: { status: "indeterminate" }, cleanup: { status: "preserved" } },
    } : { code: "already-exists" });
    expect(consumed).toBe(scenario === "competing");
    expect(await fs.readFile(target, "utf8")).toBe("winner");
    const names = await fs.readdir(capability.rootReal);
    if (indeterminate) {
      expect(names).toHaveLength(2);
      const stage = names.find(name => name !== "file")!;
      expect(stage).toMatch(/^\.fs-safe-.*\.tmp$/);
      expect(await fs.readFile(path.join(capability.rootReal, stage), "utf8")).toBe("replacement");
    } else {
      expect(names).toEqual(["file"]);
    }
  });

  it.each([0, 3])("enforces the Root byte budget of %s across chunks and closes the producer", async (maxBytes) => {
    const capability = await workspace({ maxBytes });
    let closed = false;
    async function* input() {
      try {
        yield Buffer.from("12");
        yield Buffer.from("34");
      } finally {
        closed = true;
      }
    }
    await expect(capability.create("file", input(), { maxBytes: undefined })).rejects.toMatchObject({ code: "too-large" });
    expect(closed).toBe(true);
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
    await capability.create("file", chunks("12", "34"), { maxBytes: 4 });
    expect(await fs.readFile(path.join(capability.rootReal, "file"), "utf8")).toBe("1234");
  });

  it("closes a producer whose next call rejects and preserves its error", async () => {
    const capability = await workspace();
    const failure = new Error("synthetic SQLite chunk lookup failed");
    let closed = false;
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => { throw failure; },
          return: async () => { closed = true; return { done: true, value: undefined }; },
        };
      },
    };
    await expect(capability.create("file", input)).rejects.toBe(failure);
    expect(closed).toBe(true);
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
  });

  it("waits for a pending producer pull and its close before settling cancellation", async () => {
    const capability = await workspace();
    const controller = new AbortController();
    const failure = new Error("synthetic cancellation");
    const entered = Promise.withResolvers<void>();
    const releasePull = Promise.withResolvers<IteratorResult<Uint8Array>>();
    const closing = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    let settled = false;
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => { entered.resolve(); return releasePull.promise; },
          return: async () => {
            closing.resolve();
            await releaseClose.promise;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const pending = capability.create("file", input, { signal: controller.signal });
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    controller.abort(failure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releasePull.resolve({ done: false, value: Buffer.from("late") });
    await closing.promise;
    expect(settled).toBe(false);
    releaseClose.resolve();
    await expect(pending).rejects.toBe(failure);
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
  });

  it("checks current authority after a producer wait and removes only its unpublished stage", async () => {
    const capability = await workspace();
    const failure = new Error("synthetic expired lease");
    let authorized = true;
    async function* input() {
      yield Buffer.from("first");
      authorized = false;
      yield Buffer.from("unauthorized");
    }
    await expect(capability.create("file", input(), {
      assertBeforeMutation: () => { if (!authorized) throw failure; },
    })).rejects.toBe(failure);
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
  });

  it("refuses invalid budgets and already aborted signals before pulling or creating parents", async () => {
    const capability = await workspace();
    const failure = new Error("synthetic pre-abort");
    let consumed = false;
    async function* input() { consumed = true; yield Buffer.from("unused"); }
    await expect(capability.create("nested/file", input(), { maxBytes: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(capability.create("nested/file", input(), { signal: AbortSignal.abort(failure) })).rejects.toBe(failure);
    expect(consumed).toBe(false);
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
  });

  it("retains denied-path and parent-symlink policies before consuming input", async () => {
    const capability = await workspace({ mutationSymlinks: "reject" });
    const target = path.join(capability.rootReal, "denied");
    let consumed = false;
    async function* input() { consumed = true; yield Buffer.from("unused"); }
    await expect(capability.create("denied", input(), { denyMutations: { paths: [target] } }))
      .rejects.toMatchObject({ code: "denied-path" });
    await expect(capability.create("../outside", input())).rejects.toMatchObject({ code: "path-alias" });
    expect(consumed).toBe(false);
    await fs.mkdir(path.join(capability.rootReal, "actual"));
    await fs.symlink(path.join(capability.rootReal, "actual"), path.join(capability.rootReal, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(capability.create("alias/file", input())).rejects.toMatchObject({ code: "symlink" });
    expect(consumed).toBe(false);
    await capability.create("alias/file", chunks("contained"), { mutationSymlinks: "follow-parents-within-root" });
    expect(await fs.readFile(path.join(capability.rootReal, "actual/file"), "utf8")).toBe("contained");
  });
});

it("preserves a published destination when later verification fails", async () => {
  configureFsSafeNative({ mode: "off" });
  const capability = await root(await tempRoot("fs-safe-create-stream-published-"));
  const failure = new Error("synthetic post-publication failure");
  __setFsSafeTestHooksForTest({ afterPinnedWriteFallbackRename: async () => { throw failure; } });
  await expect(capability.create("file", chunks("complete"))).rejects.toBeTruthy();
  expect(await fs.readFile(path.join(capability.rootReal, "file"), "utf8")).toBe("complete");
  expect(await fs.readdir(capability.rootReal)).toEqual(["file"]);
});
