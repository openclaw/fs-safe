import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetFsSafeNativeConfigForTest, configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest, getNativeBinding, getNativeFallbackDiagnostic } from "../src/native.js";

const mocked = vi.hoisted(() => ({ load: vi.fn(), resolve: vi.fn() }));
vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire: (url: string) => {
      const actual = original.createRequire(url);
      return Object.assign((name: string) => name === "../package.json" ? actual(name) : mocked.load(name), {
        resolve: mocked.resolve,
      });
    },
  };
});
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
const packageName = "@openclaw/fs-safe-win32-x64-msvc";

beforeEach(() => {
  __resetNativeLoaderForTest();
  configureFsSafeNative({ mode: "auto" });
  Object.defineProperty(process, "platform", { value: "win32" });
  Object.defineProperty(process, "arch", { value: "x64" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "arch", originalArch);
  vi.restoreAllMocks();
  vi.resetAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

it.each([
  { name: "selected package", requested: packageName, resolved: false, reason: "package-missing", probes: 1 },
  { name: "nested dependency", requested: "nested-dependency", resolved: true, reason: "load-failed", probes: 0 },
  { name: "self reference inside a resolved package", requested: packageName, resolved: true, reason: "load-failed", probes: 1 },
])("distinguishes a missing $name through the real loader", ({ requested, resolved, reason, probes }) => {
  const failure = Object.assign(new Error(`Cannot find module '${requested}'\nRequire stack:\n/private/secret`), { code: "MODULE_NOT_FOUND" });
  mocked.load.mockImplementation(() => { throw failure; });
  mocked.resolve.mockImplementation(() => { if (resolved) return "installed"; throw failure; });
  expect(getNativeBinding()).toBeUndefined();
  expect(getNativeFallbackDiagnostic()).toMatchObject({ reason, packageName });
  expect(mocked.load).toHaveBeenCalledExactlyOnceWith(packageName);
  expect(mocked.resolve).toHaveBeenCalledTimes(probes);
  configureFsSafeNative({ mode: "require" });
  expect(() => getNativeBinding()).toThrow(expect.objectContaining({
    code: "helper-unavailable", message: "native fs-safe helper is unavailable", cause: failure,
  }));
  expect(mocked.load).toHaveBeenCalledOnce();
});

it("reports the unsupported Linux target with its detected libc without resolving a package", () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  Object.defineProperty(process, "arch", { value: "riscv64" });
  const report = vi.spyOn(process.report, "getReport").mockReturnValue({ header: { glibcVersionRuntime: "2.39" } } as never);
  expect(getNativeBinding()).toBeUndefined();
  expect(getNativeFallbackDiagnostic()).toEqual({
    reason: "unsupported-target", target: "linux-riscv64-gnu", packageName: undefined, packageVersion: undefined,
  });
  getNativeFallbackDiagnostic();
  expect(report).toHaveBeenCalledOnce();
  expect(mocked.load).not.toHaveBeenCalled();
  expect(mocked.resolve).not.toHaveBeenCalled();
});
