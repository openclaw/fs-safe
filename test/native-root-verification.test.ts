import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Native CI provides the binding. */ }
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

describe.runIf(native?.verifyRootDirectory)("native Root verification", () => {
  it("rejects replacement between the initial fence and native opening", async () => {
    const base = await tempRoot("native-root-final-");
    const pathname = path.join(base, "root");
    fs.mkdirSync(pathname);
    configureFsSafeNative({ mode: "require" });
    const safe = await root(pathname);
    const verify = vi.fn((...args: Parameters<NonNullable<NativeBinding["verifyRootDirectory"]>>) => {
      fs.renameSync(pathname, path.join(base, "held"));
      fs.mkdirSync(pathname);
      return native!.verifyRootDirectory!(...args);
    });
    __setNativeLoaderForTest(() => ({ ...native!, verifyRootDirectory: verify }));
    await expect(safe.ensureRoot()).rejects.toMatchObject({ code: "path-mismatch" });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(pathname)).toEqual([]);
  });

  it("retains verification and close failures in their original order", async () => {
    const pathname = await tempRoot("native-root-close-");
    configureFsSafeNative({ mode: "require" });
    const safe = await root(pathname);
    const verify = vi.fn(() => ({ errorCode: "path-mismatch", errorMessage: "changed", closeErrorCode: "EIO", closeErrorMessage: "close failed" }));
    __setNativeLoaderForTest(() => ({ ...native!, verifyRootDirectory: verify }));
    await expect(safe.ensureRoot()).rejects.toMatchObject({
      name: "SuppressedError", error: { code: "EIO" }, suppressed: { code: "path-mismatch" },
    });
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("keeps an unavailable observer's descriptor pinned throughout fallback", async () => {
    const pathname = await tempRoot("native-root-fallback-");
    configureFsSafeNative({ mode: "require" });
    const safe = await root(pathname);
    let fallbackFd: number | undefined;
    let fallbackOpens = 0;
    const originalOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (fallbackFd !== undefined) {
        expect(fs.fstatSync(fallbackFd).isDirectory()).toBe(true);
        fallbackOpens++;
      }
      return originalOpen(...args);
    });
    const close = vi.spyOn(fs, "closeSync");
    const closeNative = vi.fn(native!.closeOwnedFd!.bind(native));
    __setNativeLoaderForTest(() => ({ ...native!, closeOwnedFd: closeNative, verifyRootDirectory() {
      const parent = fs.openSync(pathname, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
      try { fallbackFd = native!.openBeneath!(parent, "", fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0)).fd; }
      finally { fs.closeSync(parent); }
      return { fallbackFd };
    } }));
    await expect(safe.ensureRoot()).resolves.toBeUndefined();
    expect(fallbackOpens).toBeGreaterThan(0);
    expect(closeNative.mock.calls.filter(([fd]) => fd === fallbackFd)).toHaveLength(1);
    expect(close.mock.calls.filter(([fd]) => fd === fallbackFd)).toHaveLength(0);
  });

  it("checks the captured Root identity before native opening", async () => {
    const base = await tempRoot("native-root-before-");
    const pathname = path.join(base, "root");
    fs.mkdirSync(pathname);
    configureFsSafeNative({ mode: "require" });
    const safe = await root(pathname);
    const verify = vi.fn(native!.verifyRootDirectory!.bind(native));
    __setNativeLoaderForTest(() => ({ ...native!, verifyRootDirectory: verify }));
    fs.renameSync(pathname, path.join(base, "held"));
    fs.mkdirSync(pathname);
    await expect(safe.ensureRoot()).rejects.toMatchObject({ code: "path-mismatch" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("fails closed for a malformed native result", async () => {
    const pathname = await tempRoot("native-root-malformed-");
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => ({ ...native!, verifyRootDirectory: () => ({}) }));
    const safe = await root(pathname);
    await expect(safe.ensureRoot()).rejects.toMatchObject({ code: "helper-failed" });
  });

  it("preserves the older-binding verification route", async () => {
    const pathname = await tempRoot("native-root-legacy-");
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => ({ ...native!, verifyRootDirectory: undefined }));
    const safe = await root(pathname);
    await expect(safe.ensureRoot()).resolves.toBeUndefined();
  });
});

it.runIf(native?.openBeneath && native?.closeOwnedFd && !process.versions.bun)(
  "closes transferred addon descriptors in a real Worker without poisoning Node ownership",
  async () => {
    const directory = await tempRoot("native-root-worker-fallback-");
    const sentinel = path.join(directory, "sentinel");
    fs.writeFileSync(sentinel, "node-owned");
    const identity = fs.statSync(sentinel, { bigint: true });
    const worker = new Worker(new URL("./fixtures/native-root-fallback-worker.mjs", import.meta.url), {
      workerData: { directory }, stdout: true, stderr: true,
    });
    let stderr = "";
    let result: { nativeCloses: number; warnings: string[] } | undefined;
    let sentinelFd: number | undefined;
    worker.stdout.resume();
    worker.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    worker.on("message", message => {
      if (message.kind === "sentinel") sentinelFd = message.fd;
      else result = message;
    });
    try {
      const [code] = await once(worker, "exit", { signal: AbortSignal.timeout(15_000) });
      expect(code).toBe(0);
      expect(result?.nativeCloses).toBe(1);
      expect(result?.warnings).toEqual([]);
      expect(stderr).not.toMatch(/File descriptor .*closed but not opened in unmanaged mode/u);
      expect(sentinelFd).toBeTypeOf("number");
      let current;
      try { current = fs.fstatSync(sentinelFd!, { bigint: true }); }
      catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("EBADF"); }
      expect(current?.dev === identity.dev && current?.ino === identity.ino).toBe(false);
    } finally { await worker.terminate(); }
  }, 20_000,
);
