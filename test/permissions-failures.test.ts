import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
  inspectWindowsAcl,
  parseIcaclsOutput,
  type PermissionCheck,
} from "../src/permissions.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe("permission inspection failure modes", () => {
  it("uses verified native Windows owner and DACL facts without shell fallback", async () => {
    const root = await tempRoot("fs-safe-permission-native-");
    const target = path.join(root, "secret");
    await fs.writeFile(target, "secret", { mode: 0o600 });
    const readOwnerAndDacl = vi.fn(() => ({
      ownerSid: "S-1-5-21-42",
      currentUserSid: "S-1-5-21-42",
      ownerClass: "current-user",
      worldWritable: false,
      groupWritable: false,
      worldReadable: false,
      groupReadable: true,
      fallbackRequired: false,
      daclPresent: true,
      isLocal: true,
      aceListComplete: true,
      unsupportedAceTypes: [],
      aces: [],
    }));
    __setNativeLoaderForTest(() => ({ readOwnerAndDacl }) as unknown as NativeBinding);
    configureFsSafeNative({ mode: "require" });
    const exec = vi.fn();

    await expect(inspectPathPermissions(target, { platform: "win32", exec }))
      .resolves.toMatchObject({
        source: "windows-acl",
        ownerSid: "S-1-5-21-42",
        ownerTrusted: true,
        groupReadable: true,
      });
    expect(readOwnerAndDacl).toHaveBeenCalledWith(target);
    expect(exec).not.toHaveBeenCalled();
  });

  it("formats verified ACLs and unknown modes without inventing details", () => {
    const acl = {
      source: "windows-acl",
      aclSummary: undefined,
    } as PermissionCheck;
    expect(formatPermissionDetail("C:\\secret", acl)).toBe("C:\\secret acl=unknown");
    expect(formatPermissionRemediation({
      targetPath: "C:\\secret",
      perms: acl,
      isDir: false,
      posixMode: 0o600,
      env: { SystemRoot: "C:\\Windows", USERNAME: "me" },
    })).toContain("icacls.exe");
    expect(formatPermissionDetail("/secret", {
      ...acl,
      source: "unknown",
      bits: null,
    })).toBe("/secret mode=unknown");
  });

  it("ignores malformed and deny ACE lines while retaining a valid grant", () => {
    expect(parseIcaclsOutput([
      "no access tuple",
      "missing-colon(R)",
      "Denied:(DENY)(F)",
      "Inherited:(I)(OI)",
      "Everyone:(R)",
    ].join("\n"), "C:\\secret")).toMatchObject([
      { principal: "Everyone", rights: ["R"], canRead: true, canWrite: false },
    ]);
  });

  it("fails closed when a parsed ACL entry has no principal to translate", async () => {
    const exec = vi.fn(async () => ({ stdout: ":(R)\n", stderr: "" }));
    const result = await inspectWindowsAcl("C:\\secret", {
      exec,
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("principal SID could not be verified"),
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("attributes an injected principal translation failure to PowerShell, not icacls", async () => {
    const original = Object.assign(new Error("translation denied"), {
      code: 9, signal: null, stderr: "SID translation failed\n",
    });
    const exec = vi.fn(async (command: string) => {
      if (command.endsWith("icacls.exe")) return { stdout: "DOMAIN\\user:(R)\n", stderr: "" };
      throw original;
    });
    const result = await inspectWindowsAcl("C:\\secret", {
      exec, env: { SystemRoot: "C:\\Windows" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: "Error: translation denied",
      errorDetail: {
        command: expect.stringContaining("powershell.exe"),
        durationMs: expect.any(Number), timedOut: false, exitCode: 9, signal: null,
        stderr: "SID translation failed\\u000a",
      },
    });
    expect(result.errorCause).toBe(original);
    expect(exec.mock.calls.map(([command]) => path.win32.basename(command))).toEqual([
      "icacls.exe", "powershell.exe",
    ]);
  });
});
