import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PermissionCheck } from "../src/permissions.js";

const mocks = vi.hoisted(() => ({ binding: vi.fn() }));
vi.mock("../src/native.js", () => ({ getNativeBinding: mocks.binding }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  vi.resetModules();
  mocks.binding.mockReset().mockReturnValue(undefined);
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });

async function builders(isDir: boolean) {
  const { createIcaclsResetCommand, formatIcaclsResetCommand } = await import("../src/permissions-windows.js");
  const { formatPermissionRemediation } = await import("../src/permissions.js");
  const targetPath = "C:\\private", env = { USERNAME: "owner", SystemRoot: "C:\\Windows" };
  return [
    () => formatIcaclsResetCommand(targetPath, { isDir, env }),
    () => createIcaclsResetCommand(targetPath, { isDir, env })?.display,
    () => formatPermissionRemediation({ targetPath, env, isDir, posixMode: 0o700,
      perms: { source: "windows-acl" } as PermissionCheck }),
  ];
}

it.each([false, true])("refuses every reset builder inside a container (directory=%s)", async isDir => {
  mocks.binding.mockReturnValue({ isWindowsAppContainer: () => true });
  for (const build of await builders(isDir)) {
    expect(build).toThrow(expect.objectContaining({ name: "FsSafeError", code: "helper-unavailable" }));
  }
});

it.each([false, true])("preserves ordinary and unavailable-addon commands (directory=%s)", async isDir => {
  const grant = isDir ? "(OI)(CI)F" : "F";
  const expected = `C:\\Windows\\System32\\icacls.exe "C:\\private" /inheritance:r /grant:r "owner:${grant}" /grant:r "*S-1-5-18:${grant}"`;
  for (const binding of [undefined, {}, { isWindowsAppContainer: () => false }]) {
    mocks.binding.mockReturnValue(binding);
    for (const build of await builders(isDir)) expect(build()).toBe(expected);
  }
  mocks.binding.mockImplementation(() => { throw new Error("addon unavailable"); });
  for (const build of await builders(isDir)) expect(build()).toBe(expected);
});

it("fails typed when the in-process membership probe fails", async () => {
  mocks.binding.mockReturnValue({ isWindowsAppContainer: () => { throw new Error("token denied"); } });
  for (const build of await builders(true)) {
    expect(build).toThrow(expect.objectContaining({ name: "FsSafeError", code: "permission-unverified" }));
  }
});
