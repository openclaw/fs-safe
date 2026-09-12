import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "../src/durability.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { useTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch (error) {
  if (process.env.FS_SAFE_NATIVE_MODE === "require") throw error;
}

const { tempRoot } = useTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

async function fixture(contents: string | Buffer): Promise<string> {
  const directory = await tempRoot("fs-safe-hash-options-");
  const file = path.join(directory, "payload");
  await fs.writeFile(file, contents);
  return file;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const mode of ["off", "require"] as const) {
  describe.runIf(mode === "off" || Boolean(native))(`bounded SHA-256 (${mode})`, () => {
    beforeEach(() => {
      configureFsSafeNative({ mode });
      if (mode === "require") __setNativeLoaderForTest(() => native!);
    });

    it.each([undefined, Infinity, 6])("hashes the complete file with limit %s", async (maxBytes) => {
      const file = await fixture("abcdef");
      const handle = await fs.open(file, "r");
      const expected = {
        bytes: 6,
        digest: createHash("sha256").update("abcdef").digest("hex"),
      };
      try {
        await handle.read(Buffer.alloc(2), 0, 2, null);
        await expect(sha256File(handle, { maxBytes })).resolves.toEqual(expected);
        await expect(sha256File(file, { maxBytes })).resolves.toEqual(expected);
        const next = Buffer.alloc(1);
        await handle.read(next, 0, 1, null);
        expect(next.toString()).toBe("c");
      } finally {
        await handle.close();
      }
    });

    it("accepts an empty file at zero and rejects a nonempty file without consuming its offset", async () => {
      const file = await fixture("");
      await expect(sha256File(file, { maxBytes: 0 })).resolves.toEqual({
        bytes: 0,
        digest: createHash("sha256").digest("hex"),
      });
      await fs.writeFile(file, "abcdef");
      const handle = await fs.open(file, "r");
      try {
        await handle.read(Buffer.alloc(2), 0, 2, null);
        for (const maxBytes of [0, 5]) {
          await expect(sha256File(file, { maxBytes })).rejects.toMatchObject({ code: "too-large" });
          await expect(sha256File(handle, { maxBytes })).rejects.toMatchObject({ code: "too-large" });
        }
        const next = Buffer.alloc(1);
        await handle.read(next, 0, 1, null);
        expect(next.toString()).toBe("c");
      } finally {
        await handle.close();
      }
    });
  });
}

it.each([-1, -Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid limit %s before I/O or native loading",
  async (maxBytes) => {
    const file = await fixture("abc");
    const handle = await fs.open(file, "r");
    const loader = vi.fn(() => { throw new Error("unexpected native loading"); });
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(loader);
    const open = vi.spyOn(fs, "open");
    const lstat = vi.spyOn(fsSync, "lstatSync");
    const fstat = vi.spyOn(fsSync, "fstatSync");
    const read = vi.spyOn(handle, "read");
    try {
      await expect(sha256File(file, { maxBytes })).rejects.toBeInstanceOf(RangeError);
      await expect(sha256File(handle, { maxBytes })).rejects.toBeInstanceOf(RangeError);
      expect(open).not.toHaveBeenCalled();
      expect(lstat).not.toHaveBeenCalled();
      expect(fstat).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(loader).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  },
);

it("preserves a pre-aborted reason without I/O or native loading", async () => {
  const file = await fixture("abc");
  const handle = await fs.open(file, "r");
  const reason = { cancellation: "caller-owned reason" };
  const signal = AbortSignal.abort(reason);
  const loader = vi.fn(() => { throw new Error("unexpected native loading"); });
  configureFsSafeNative({ mode: "require" });
  __setNativeLoaderForTest(loader);
  const open = vi.spyOn(fs, "open");
  const lstat = vi.spyOn(fsSync, "lstatSync");
  const fstat = vi.spyOn(fsSync, "fstatSync");
  const read = vi.spyOn(handle, "read");
  try {
    await expect(sha256File(file, { signal })).rejects.toBe(reason);
    await expect(sha256File(handle, { signal })).rejects.toBe(reason);
    expect(open).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(fstat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  } finally {
    await handle.close();
  }
});

it.each([0, 3, 256 * 1024])("reads at most limit + 1 bytes when a file grows past %s", async (maxBytes) => {
  const file = await fixture(Buffer.alloc(maxBytes, 0x61));
  const handle = await fs.open(file, "r");
  configureFsSafeNative({ mode: "off" });
  const realRead = handle.read.bind(handle);
  let bytes = 0;
  let reads = 0;
  vi.spyOn(handle, "read").mockImplementation(async (...args) => {
    if (reads++ === 0) await fs.appendFile(file, Buffer.alloc(64 * 1024, 0x62));
    const result = await realRead(...args);
    bytes += result.bytesRead;
    return result;
  });
  try {
    await expect(sha256File(handle, { maxBytes })).rejects.toMatchObject({ code: "too-large" });
    expect(bytes).toBe(maxBytes + 1);
  } finally {
    await handle.close();
  }
});

it.each(["path", "handle"] as const)("joins a pending fallback read before rejecting an aborted %s hash", async (input) => {
  const file = await fixture("abcdef");
  configureFsSafeNative({ mode: "off" });
  const handle = await fs.open(file, "r");
  await handle.read(Buffer.alloc(2), 0, 2, null);
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  const reason = new Error("hash cancelled during read");
  const realRead = handle.read.bind(handle);
  const read = vi.spyOn(handle, "read").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return await realRead(...args);
  });
  const close = vi.spyOn(handle, "close");
  if (input === "path") vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
  let settled = false;
  const operation = sha256File(input === "path" ? file : handle, { signal: controller.signal })
    .then((result) => { settled = true; return result; }, (error: unknown) => { settled = true; return error; });
  try {
    await Promise.race([entered.promise, operation.then(() => { throw new Error("read was not entered"); })]);
    controller.abort(reason);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(settled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    release.resolve();
    expect(await operation).toBe(reason);
    expect(read).toHaveBeenCalledTimes(1);
    if (input === "path") {
      expect(handle.fd).toBe(-1);
      expect(close).toHaveBeenCalledOnce();
    } else {
      const next = Buffer.alloc(1);
      await realRead(next, 0, 1, null);
      expect(next.toString()).toBe("c");
      expect(close).not.toHaveBeenCalled();
    }
  } finally {
    release.resolve();
    await operation;
    if (handle.fd !== -1) await handle.close();
  }
});

it.runIf(Boolean(native))("rejects growth after admission in the native hasher", async () => {
  const file = await fixture("abc");
  const handle = await fs.open(file, "r");
  configureFsSafeNative({ mode: "require" });
  let entered = false;
  __setNativeLoaderForTest(() => ({
    ...native!,
    sha256File(...args) {
      entered = true;
      fsSync.appendFileSync(file, Buffer.alloc(64 * 1024, 0x62));
      return native!.sha256File(...args);
    },
  }));
  try {
    await expect(sha256File(handle, { maxBytes: 3 })).rejects.toMatchObject({ code: "too-large" });
    expect(entered).toBe(true);
  } finally {
    await handle.close();
  }
});

it.runIf(Boolean(native))("cancels concurrent native hashes after an earlier hash completed on the same parent signal", async () => {
  configureFsSafeNative({ mode: "require" });
  const file = await fixture("abcdef");
  const handle = await fs.open(file, "r");
  const controller = new AbortController();
  const onAbort = vi.fn();
  controller.signal.onabort = onAbort;
  const reason = new Error("native hashes cancelled");
  const entered = deferred();
  let calls = 0;
  let pending = 0;
  const forwardedSignals: AbortSignal[] = [];
  __setNativeLoaderForTest(() => ({
    ...native!,
    sha256File(...args) {
      calls++;
      pending++;
      if (args[2]) forwardedSignals.push(args[2]);
      const operation = native!.sha256File(...args).finally(() => { pending--; });
      if (calls === 3) entered.resolve();
      return operation;
    },
  }));
  const operations: Array<Promise<unknown>> = [];
  try {
    await handle.read(Buffer.alloc(2), 0, 2, null);
    await expect(sha256File(handle, { signal: controller.signal })).resolves.toMatchObject({ bytes: 6 });
    expect(forwardedSignals[0]!.onabort).toBeNull();
    await fs.truncate(file, 256 * 1024 * 1024);
    for (let index = 0; index < 2; index++) {
      operations.push(sha256File(handle, { signal: controller.signal }).catch((error: unknown) => error));
    }
    await Promise.race([entered.promise, Promise.all(operations).then(() => { throw new Error("native hashes were not entered"); })]);
    controller.abort(reason);
    for (const error of await Promise.all(operations)) expect(error).toBe(reason);
    expect(pending).toBe(0);
    for (const signal of forwardedSignals) expect(signal.onabort).toBeNull();
    expect(onAbort).toHaveBeenCalledOnce();
    const next = Buffer.alloc(1);
    await handle.read(next, 0, 1, null);
    expect(next.toString()).toBe("c");
  } finally {
    controller.abort(reason);
    await Promise.allSettled(operations);
    await handle.close();
  }
});
