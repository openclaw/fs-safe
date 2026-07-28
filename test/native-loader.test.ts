import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafePython,
  configureFsSafeNative,
  getFsSafeNativeConfig,
} from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __nativeLoaderDetectorsForTest,
  __nativeTargetForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  getNativeBinding,
  type NativeBinding,
} from "../src/native.js";

const envKeys = [
  "FS_SAFE_NATIVE_MODE",
  "OPENCLAW_FS_SAFE_NATIVE_MODE",
  "FS_SAFE_PYTHON_MODE",
  "OPENCLAW_FS_SAFE_PYTHON_MODE",
  "FS_SAFE_PYTHON",
  "OPENCLAW_FS_SAFE_PYTHON",
  "OPENCLAW_PINNED_PYTHON",
  "OPENCLAW_PINNED_WRITE_PYTHON",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("native helper configuration", () => {
  it("reads the environment and lets programmatic configuration win", () => {
    process.env.FS_SAFE_NATIVE_MODE = "off";
    expect(getFsSafeNativeConfig()).toEqual({ mode: "off" });
    configureFsSafeNative({ mode: "require" });
    expect(getFsSafeNativeConfig()).toEqual({ mode: "require" });
  });

  it("accepts documented boolean and compatibility mode spellings", () => {
    process.env.FS_SAFE_NATIVE_MODE = "required";
    expect(getFsSafeNativeConfig()).toEqual({ mode: "require" });
    process.env.FS_SAFE_NATIVE_MODE = "never";
    expect(getFsSafeNativeConfig()).toEqual({ mode: "off" });
    process.env.FS_SAFE_NATIVE_MODE = "true";
    expect(getFsSafeNativeConfig()).toEqual({ mode: "auto" });
  });

  it("warns once and maps legacy Python configuration during the 0.5 migration", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    process.env.FS_SAFE_PYTHON_MODE = "required";
    process.env.FS_SAFE_PYTHON = "/legacy/python";

    expect(getFsSafeNativeConfig()).toEqual({ mode: "require" });
    expect(getFsSafeNativeConfig()).toEqual({ mode: "require" });
    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('mapped to native mode "require"'),
      expect.objectContaining({ code: "FS_SAFE_PYTHON_DEPRECATED" }),
    );
  });

  it("keeps configureFsSafePython as a warning migration bridge only for 0.5", () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    configureFsSafePython({ mode: "off", pythonPath: "/legacy/python" });

    expect(getFsSafeNativeConfig()).toEqual({ mode: "off" });
    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("configureFsSafeNative"),
      expect.objectContaining({ code: "FS_SAFE_PYTHON_DEPRECATED" }),
    );
  });

  it("falls back in auto mode and fails closed in require mode", () => {
    const unavailable = vi.fn(() => {
      throw Object.assign(new Error("missing binding"), { code: "MODULE_NOT_FOUND" });
    });
    __setNativeLoaderForTest(unavailable);
    configureFsSafeNative({ mode: "auto" });
    expect(getNativeBinding()).toBeUndefined();
    expect(unavailable).toHaveBeenCalledTimes(1);

    configureFsSafeNative({ mode: "require" });
    expect(() => getNativeBinding()).toThrowError(
      expect.objectContaining({ code: "helper-unavailable" }),
    );
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it("does not attempt to load the binding in off mode", () => {
    const loader = vi.fn(() => ({}) as NativeBinding);
    __setNativeLoaderForTest(loader);
    configureFsSafeNative({ mode: "off" });
    expect(getNativeBinding()).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("bundled native loader", () => {
  let hostBinding: NativeBinding | undefined;
  try {
    hostBinding = __loadBundledNativeForTest();
  } catch {
    // Ordinary JavaScript-only jobs intentionally run without a built binding.
  }

  it.runIf(Boolean(hostBinding))("loads the bundled binary for the host target", () => {
    expect(hostBinding?.openBeneath).toBeTypeOf("function");
    expect(hostBinding?.sha256File).toBeTypeOf("function");
  });

  it("maps every bundled target without probing the host", () => {
    expect(__nativeTargetForTest("linux", "x64")).toBe("linux-x64-gnu");
    expect(__nativeTargetForTest("linux", "x64", true)).toBe("linux-x64-musl");
    expect(__nativeTargetForTest("linux", "arm64")).toBe("linux-arm64-gnu");
    expect(__nativeTargetForTest("linux", "arm64", true)).toBe("linux-arm64-musl");
    expect(__nativeTargetForTest("darwin", "x64")).toBe("darwin-x64");
    expect(__nativeTargetForTest("darwin", "arm64")).toBe("darwin-arm64");
    expect(__nativeTargetForTest("win32", "x64")).toBe("win32-x64-msvc");
    expect(__nativeTargetForTest("freebsd", "x64")).toBeUndefined();
    expect(__nativeTargetForTest("linux", "ppc64")).toBeUndefined();
  });

  it("runs only non-executing libc probes", () => {
    const detected = __nativeLoaderDetectorsForTest();
    expect([true, false, undefined]).toContain(detected.report);
    expect([true, undefined]).toContain(detected.filesystem);
    expect([true, false, undefined]).toContain(detected.elfInterpreter);
    if (process.platform === "linux") {
      expect(detected.elfInterpreter).toBeTypeOf("boolean");
    }
  });

  it("contains no import-time process execution path", () => {
    const loader = readFileSync(fileURLToPath(new URL("../src/native.ts", import.meta.url)), "utf8");
    expect(loader).not.toMatch(/(?:child_process|execSync|execFileSync|spawnSync|\bspawn\s*\()/);
    expect(loader).toContain("isMuslFromElfInterpreter");
    expect(loader).toContain("Unknown Linux libc: try the glibc binary");
    expect(loader).toContain('"fs-safe-native.node"');
    expect(loader).not.toContain("@openclaw/fs-safe-native");
  });
});
