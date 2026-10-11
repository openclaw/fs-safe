import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { inspectWindowsAcl } from "../src/permissions-windows.js";

vi.mock("../src/windows-security-helper.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/windows-security-helper.js")>(),
  windowsSecurityHelperPath: () => fileURLToPath(new URL("./absent/windows-security-helper.exe", import.meta.url)),
}));

it("fails closed with rebuild guidance when the built-in owner helper is missing", async () => {
  // Explicit exec routes the public inspector identically on every host.
  const { executePermissionCommand } = await import("../src/permission-exec.js");
  const result = await inspectWindowsAcl("C:\\fixture", { exec: executePermissionCommand });
  expect(result).toMatchObject({
    ok: false, entries: [],
    error: expect.stringContaining("rebuild with pnpm build:windows-helper or reinstall @openclaw/fs-safe"),
    errorDetail: {
      command: expect.stringContaining("absent"), timedOut: false,
      exitCode: null, signal: null, stderr: "",
    },
  });
  expect(result.errorCause).toMatchObject({ name: "PermissionCommandError", cause: { code: "ENOENT" } });
});
