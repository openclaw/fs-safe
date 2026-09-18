import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root, type RootCreateStreamOptions } from "../src/index.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { hasPrivateCreationNative } from "./helpers/private-creation-native.js";
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
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});

function pausedInput() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let closed = false;
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    get closed() { return closed; },
    stream: (async function* () {
      try {
        entered.resolve();
        await release.promise;
        yield Buffer.from("complete");
      } finally {
        closed = true;
      }
    })(),
  };
}

describe.each(modes)("streamed Root.create authority snapshot (native %s)", (mode) => {
  async function workspace() {
    configureFsSafeNative({ mode });
    return await root(await tempRoot("fs-safe-create-authority-snapshot-"));
  }

  for (const privateCreation of [false, true]) {
    const unavailable = privateCreation && process.platform === "darwin" && (mode === "off" || !hasPrivateCreationNative());
    it.skipIf(unavailable).each(["replace", "delete"] as const)(`retains a revoked callback when the caller tries to %s it during a producer pull (private=${privateCreation})`, async (change) => {
      const capability = await workspace();
      const failure = new Error("synthetic expired lease");
      let authorized = true;
      const receivers: unknown[] = [];
      const options: RootCreateStreamOptions = {
        private: privateCreation,
        assertBeforeMutation() { receivers.push(this); if (!authorized) throw failure; },
      };
      const input = pausedInput();
      const pending = capability.create("file", input.stream, options).then(
        () => ({ completed: true }),
        error => ({ completed: false, error }),
      );
      await input.entered;
      authorized = false;
      if (change === "replace") options.assertBeforeMutation = () => undefined;
      else delete options.assertBeforeMutation;
      input.release();
      const outcome = await pending;
      const names = await fs.readdir(capability.rootReal);
      const published = names.includes("file") ? await fs.readFile(path.join(capability.rootReal, "file"), "utf8") : undefined;
      expect({ outcome, names, published, closed: input.closed }).toEqual({
        outcome: { completed: false, error: failure }, names: [], published: undefined, closed: true,
      });
      expect(receivers.length).toBeGreaterThan(0);
      expect(receivers.every(receiver => receiver === options)).toBe(true);
    }, privateCreation && process.platform === "win32" ? 120_000 : undefined);
  }

  it.each([undefined, null, false, 0, "revoked", Object.freeze({ reason: "revoked" })])("preserves the exact authority refusal %j", async (failure) => {
    const capability = await workspace();
    let authorized = true;
    const options = { assertBeforeMutation() { if (!authorized) throw failure; } };
    const input = pausedInput();
    const pending = capability.create("file", input.stream, options).then(
      () => ({ completed: true, error: undefined }),
      error => ({ completed: false, error }),
    );
    await input.entered;
    authorized = false;
    options.assertBeforeMutation = () => undefined;
    input.release();
    const outcome = await pending;
    expect(outcome.completed).toBe(false);
    expect(outcome.error).toBe(failure);
    expect(input.closed).toBe(true);
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
  });

  it.each(["promise", "thenable"] as const)("still rejects a captured callback returning a %s after a producer wait", async (kind) => {
    const capability = await workspace();
    const failure = new Error("asynchronous refusal");
    let asynchronous = false;
    let refusals = 0;
    const options = {
      assertBeforeMutation() {
        if (!asynchronous) return;
        if (kind === "promise") { refusals++; return Promise.reject(failure); }
        return { then(_resolve: unknown, reject: (error: unknown) => void) { refusals++; reject(failure); } };
      },
    };
    const input = pausedInput();
    const pending = capability.create("file", input.stream, options);
    const rejected = expect(pending).rejects.toThrow("assertBeforeMutation must be synchronous");
    await input.entered;
    asynchronous = true;
    options.assertBeforeMutation = () => undefined;
    input.release();
    await rejected;
    expect(refusals).toBe(1);
    expect(input.closed).toBe(true);
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
  });

  it("keeps the original signal and ignores a replacement signal aborted during a producer pull", async () => {
    const capability = await workspace();
    const controller = new AbortController();
    const options = { signal: controller.signal, assertBeforeMutation: () => ({ then: false }) };
    const input = pausedInput();
    const pending = capability.create("file", input.stream, options);
    await input.entered;
    options.signal = AbortSignal.abort(new Error("unrelated replacement signal"));
    input.release();
    await pending;
    expect(input.closed).toBe(true);
    expect(await fs.readFile(path.join(capability.rootReal, "file"), "utf8")).toBe("complete");
    expect(await fs.readdir(capability.rootReal)).toEqual(["file"]);
  });

  it("rejects an already-aborted signal before reading the authority callback", async () => {
    const capability = await workspace();
    const failure = new Error("already aborted");
    const options = {
      signal: AbortSignal.abort(failure),
      get assertBeforeMutation(): () => void { throw new Error("callback must not be read"); },
    };
    const input = pausedInput();
    await expect(capability.create("file", input.stream, options)).rejects.toBe(failure);
    expect(input.closed).toBe(false);
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
  });

  it.each(["replace", "delete", "getter", "inherited", "non-enumerable"] as const)("honors the original signal when options use %s", async (change) => {
    const capability = await workspace();
    const controller = new AbortController();
    const replacement = new AbortController();
    const failure = new Error("original signal aborted");
    const options: RootCreateStreamOptions = change === "inherited"
      ? Object.create({ signal: controller.signal })
      : { signal: controller.signal };
    let reads = 0;
    if (change === "getter") Object.defineProperty(options, "signal", {
      enumerable: true, get: () => reads++ === 0 ? controller.signal : replacement.signal,
    });
    if (change === "non-enumerable") Object.defineProperty(options, "signal", { enumerable: false });
    const input = pausedInput();
    const pending = capability.create("file", input.stream, options);
    const rejected = expect(pending).rejects.toBe(failure);
    await input.entered;
    if (change === "replace") options.signal = replacement.signal;
    if (change === "delete") delete options.signal;
    controller.abort(failure);
    input.release();
    await rejected;
    expect(input.closed).toBe(true);
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
  });

  it.each(["replace", "delete"] as const)("retains cancellation before publication when the caller tries to %s the signal after producer completion", async (change) => {
    const capability = await workspace();
    const controller = new AbortController();
    const failure = new Error("aborted before publication");
    const options: RootCreateStreamOptions = { signal: controller.signal, durable: "file" };
    let completed = false;
    let stageFd: number | undefined;
    async function* input() { yield Buffer.from("complete"); completed = true; }
    const revoke = (fd: number) => {
      if (stageFd !== undefined || !fsSync.fstatSync(fd).isFile()) return;
      expect(completed).toBe(true);
      expect(fsSync.existsSync(path.join(capability.rootReal, "file"))).toBe(false);
      stageFd = fd;
      if (change === "replace") options.signal = new AbortController().signal;
      else delete options.signal;
      controller.abort(failure);
    };
    const sync = fsSync.fsyncSync;
    vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => { sync(fd); revoke(fd); });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); revoke(handle.fd); });
      return handle;
    });
    await expect(capability.create("file", input(), options)).rejects.toBe(failure);
    expect(stageFd).toBeDefined();
    expect(() => fsSync.fstatSync(stageFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(await fs.readdir(capability.rootReal)).toEqual([]);
  });
});
