import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
  getFsSafeNativeConfig,
  getNativeModeSetting,
  isFsSafeNativeRequired,
} from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, getNativeBinding } from "../src/native.js";

const legacyKeys = ["FS_SAFE_PYTHON_MODE", "OPENCLAW_FS_SAFE_PYTHON_MODE"] as const;

beforeEach(() => {
  for (const key of [...legacyKeys, "FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"]) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe("removed Python mode migration", () => {
  for (const key of legacyKeys) {
    it.each(["require", "off", "auto", "required", "never", "invalid", ""])(
      `rejects ${key}=%s before selecting a native policy`, (mode) => {
        vi.stubEnv(key, mode);
        for (const read of [getFsSafeNativeConfig, getNativeModeSetting, isFsSafeNativeRequired]) {
          expect(read).toThrow(`${key} has been removed`);
          expect(read).toThrow("FS_SAFE_NATIVE_MODE=");
        }
        const loader = vi.fn();
        __setNativeLoaderForTest(loader);
        expect(() => getNativeBinding()).toThrow(`${key} has been removed`);
        expect(loader).not.toHaveBeenCalled();
      },
    );

    it.each(["require", "off", "auto"] as const)(
      `preserves explicit native overrides over ${key} (%s)`, (mode) => {
        vi.stubEnv(key, "require");
        vi.stubEnv("OPENCLAW_FS_SAFE_NATIVE_MODE", mode);
        expect(getFsSafeNativeConfig()).toEqual({ mode });
        expect(getNativeModeSetting()).toEqual({ mode, source: "OPENCLAW_FS_SAFE_NATIVE_MODE" });
        expect(isFsSafeNativeRequired()).toBe(mode === "require");

        vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
        expect(getFsSafeNativeConfig()).toEqual({ mode: "off" });
        configureFsSafeNative({ mode });
        expect(getFsSafeNativeConfig()).toEqual({ mode });
        expect(getNativeModeSetting()).toEqual({ mode, source: "programmatic configuration" });
      },
    );
  }

  it("does not let an invalid native override hide a removed mode", () => {
    vi.stubEnv("FS_SAFE_PYTHON_MODE", "require");
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "invalid");
    expect(getFsSafeNativeConfig).toThrow("FS_SAFE_NATIVE_MODE=require");
  });

  it("keeps migrated require fail-closed and migrated off from loading the addon", () => {
    vi.stubEnv("FS_SAFE_PYTHON_MODE", "require");
    const loader = vi.fn(() => { throw new Error("missing addon"); });
    __setNativeLoaderForTest(loader);
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    expect(getNativeBinding()).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "require");
    expect(() => getNativeBinding()).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
    expect(loader).toHaveBeenCalledOnce();
  });
});
