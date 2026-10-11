import fs from "node:fs";
import path from "node:path";
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
    __setNativeLoaderForTest(() => ({ ...native!, verifyRootDirectory() {
      fallbackFd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      return { fallbackFd };
    } }));
    await expect(safe.ensureRoot()).resolves.toBeUndefined();
    expect(fallbackOpens).toBeGreaterThan(0);
    expect(close.mock.calls.filter(([fd]) => fd === fallbackFd)).toHaveLength(1);
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
