import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ binding: vi.fn(), membership: vi.fn() }));
vi.mock("../src/native.js", () => ({ getNativeBinding: mocks.binding }));
vi.mock("../src/windows-security-command.js", () => ({ readWindowsAppContainerCommand: mocks.membership }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const denied = () => Object.assign(new Error("denied"), {
  code: "EPERM", errno: -4048, syscall: "realpath", path: "C:\\fixture",
});

beforeEach(() => {
  vi.resetModules();
  mocks.binding.mockReset().mockReturnValue(undefined);
  mocks.membership.mockReset().mockReturnValue(false);
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });

async function resolver(error: Error) {
  vi.spyOn(fs.realpathSync, "native").mockImplementation(() => { throw error; });
  return (await import("../src/realpath.js")).realpathSync.native;
}

function thrownBy(resolve: (path: string) => string) {
  try { resolve("C:\\fixture"); } catch (error) { return error; }
  throw new Error("expected a denial");
}

it.each(["native", "helper"])("preserves the identical non-container EPERM with the %s probe", async source => {
  const probe = vi.fn(() => false), translate = vi.fn();
  if (source === "native") mocks.binding.mockReturnValue({ isWindowsAppContainer: probe, resolveWindowsCanonicalPath: translate });
  const original = denied();
  const resolve = await resolver(original);
  expect(thrownBy(resolve)).toBe(original);
  expect(thrownBy(resolve)).toBe(original);
  expect(original).toMatchObject({ code: "EPERM", errno: -4048, syscall: "realpath", path: "C:\\fixture" });
  expect(source === "native" ? probe : mocks.membership).toHaveBeenCalledTimes(1);
  expect(translate).not.toHaveBeenCalled();
});

it("does not probe the token for successful resolution or other filesystem failures", async () => {
  const original = Object.assign(new Error("missing"), { code: "ENOENT", syscall: "realpath" });
  const resolve = await resolver(original);
  expect(thrownBy(resolve)).toBe(original);
  vi.mocked(fs.realpathSync.native).mockReturnValue("C:\\fixture");
  expect(resolve("C:\\fixture")).toBe("C:\\fixture");
  expect(mocks.binding).not.toHaveBeenCalled();
  expect(mocks.membership).not.toHaveBeenCalled();
});

it("preserves an ordinary denial when the required addon cannot load", async () => {
  mocks.binding.mockImplementation(() => { throw new Error("addon unavailable"); });
  const original = denied();
  expect(thrownBy(await resolver(original))).toBe(original);
  expect(mocks.membership).toHaveBeenCalledTimes(1);
});

it("preserves the original container denial when native resolution cannot replace it", async () => {
  mocks.binding.mockReturnValue({ isWindowsAppContainer: () => true, resolveWindowsCanonicalPath: () => null });
  const original = denied();
  expect(thrownBy(await resolver(original))).toBe(original);
});

it("uses a successful container translation and retains typed unsupported-translation errors", async () => {
  const translate = vi.fn().mockReturnValue("C:\\Long name");
  mocks.binding.mockReturnValue({ isWindowsAppContainer: () => true, resolveWindowsCanonicalPath: translate });
  const resolve = await resolver(denied());
  expect(resolve("C:\\fixture")).toBe("C:\\Long name");
  translate.mockImplementation(() => { throw new Error("unsupported namespace"); });
  expect(thrownBy(resolve)).toMatchObject({ name: "FsSafeError", code: "path-mismatch" });
});

it("fails typed when token membership is unknown", async () => {
  mocks.membership.mockImplementation(() => { throw new Error("token probe denied"); });
  expect(thrownBy(await resolver(denied()))).toMatchObject({ name: "FsSafeError", code: "permission-unverified" });
});

it("fails typed when a contained process has no native canonicalizer", async () => {
  mocks.membership.mockReturnValue(true);
  expect(thrownBy(await resolver(denied()))).toMatchObject({ name: "FsSafeError", code: "helper-unavailable" });
});
