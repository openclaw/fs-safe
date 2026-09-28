import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, getFsSafeNativeConfig, isFsSafeNativeRequired,
  __resetFsSafeNativeConfigForTest } from "../src/native-config.js";

const keys = ["FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE", "FS_SAFE_PYTHON_MODE",
  "OPENCLAW_FS_SAFE_PYTHON_MODE", "FS_SAFE_PYTHON", "OPENCLAW_FS_SAFE_PYTHON",
  "OPENCLAW_PINNED_PYTHON", "OPENCLAW_PINNED_WRITE_PYTHON"];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

it.each([
  [{}, false],
  [{ FS_SAFE_NATIVE_MODE: " REQUIRED " }, true],
  [{ FS_SAFE_NATIVE_MODE: "invalid", OPENCLAW_FS_SAFE_NATIVE_MODE: "require" }, true],
  [{ FS_SAFE_NATIVE_MODE: "off", OPENCLAW_FS_SAFE_NATIVE_MODE: "require" }, false],
  [{ FS_SAFE_PYTHON_MODE: "require" }, true],
  [{ OPENCLAW_FS_SAFE_PYTHON_MODE: "require" }, true],
  [{ FS_SAFE_PYTHON_MODE: "", OPENCLAW_FS_SAFE_PYTHON_MODE: "require" }, false],
  [{ FS_SAFE_PYTHON_MODE: "invalid", OPENCLAW_FS_SAFE_PYTHON_MODE: "require" }, false],
  [{ FS_SAFE_PYTHON: "/synthetic/python" }, false],
] as const)("preserves mode precedence for required-operation routing (%j)", (environment, expected) => {
  for (const key of keys) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  expect(isFsSafeNativeRequired()).toBe(expected);
  expect(getFsSafeNativeConfig().mode === "require").toBe(expected);
  configureFsSafeNative({ mode: "auto" });
  expect(isFsSafeNativeRequired()).toBe(false);
  configureFsSafeNative({ mode: "require" });
  expect(isFsSafeNativeRequired()).toBe(true);
});

it("keeps environment changes live and leaves legacy diagnostics to the config API", () => {
  for (const key of keys) vi.stubEnv(key, undefined);
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  expect(isFsSafeNativeRequired()).toBe(false);
  vi.stubEnv("FS_SAFE_PYTHON_MODE", "require");
  expect(isFsSafeNativeRequired()).toBe(true);
  expect(warning).not.toHaveBeenCalled();
  expect(getFsSafeNativeConfig().mode).toBe("require");
  expect(warning).toHaveBeenCalledOnce();
});
