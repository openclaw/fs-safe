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

  it("retains explicit advanced classification and translation-failure options", async () => {
    const exec = vi.fn(async () => ({ stdout: JSON.stringify({
      ownerSid: "S-1-5-21-42", currentUserSid: "S-1-5-21-42", complete: true, daclPresent: true,
      aces: [{ sid: "S-1-5-21-99", mask: 1, deny: false, inheritOnly: false }],
    }), stderr: "" }));
    const result = await inspectWindowsAcl("C:\\fixture", { exec, currentUserSid: "S-1-5-21-99" });
    expect(result.trusted).toMatchObject([{ sid: "s-1-5-21-99" }]);
    exec.mockClear();
    await expect(inspectWindowsAcl("C:\\fixture", { exec, principalTranslationFailed: true }))
      .resolves.toMatchObject({ ok: false, error: "Error: Windows ACL principal SID translation failed" });
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    { complete: false },
    { aces: [{ sid: "invalid", mask: 1, deny: false, inheritOnly: false }] },
    { aces: [{ sid: "S-1-1-0", mask: -1, deny: false, inheritOnly: false }] },
    { aces: [{ sid: "S-1-1-0", mask: 1, inheritOnly: false }] },
  ])("leaves incomplete or malformed descriptor facts unverified", async override => {
    const result = await inspectWindowsAcl("C:\\fixture", {
      exec: async () => ({ stdout: JSON.stringify({ ownerSid: "S-1-5-21-42", currentUserSid: "S-1-5-21-42",
        complete: true, daclPresent: true, aces: [], ...override }), stderr: "" }),
    });
    expect(result).toMatchObject({ ok: false, entries: [], error: expect.stringContaining("Windows ACL query returned") });
  });

  it.each([false, true])("distinguishes a null DACL from an empty DACL (present=%s)", async daclPresent => {
    const result = await inspectWindowsAcl("C:\\fixture", {
      exec: async () => ({ stdout: JSON.stringify({ ownerSid: "S-1-5-21-42", currentUserSid: "S-1-5-21-42",
        complete: true, daclPresent, aces: [] }), stderr: "" }),
    });
    expect(result.ok).toBe(true);
    if (daclPresent) expect(result.entries).toEqual([]);
    else expect(result.untrustedWorld).toMatchObject([{ sid: "s-1-1-0", canRead: true, canWrite: true }]);
  });

  it("ignores inherit-only grants and never subtracts deny entries from coarse grants", async () => {
    const result = await inspectWindowsAcl("C:\\fixture", {
      exec: async () => ({ stdout: JSON.stringify({ ownerSid: "S-1-5-21-42", currentUserSid: "S-1-5-21-42",
        complete: true, daclPresent: true, aces: [
          { sid: "S-1-1-0", mask: 0x001f01ff, deny: true, inheritOnly: false },
          { sid: "S-1-1-0", mask: 1, deny: false, inheritOnly: false },
          { sid: "S-1-5-32-545", mask: 0x001f01ff, deny: false, inheritOnly: true },
        ] }), stderr: "" }),
    });
    expect(result.ok).toBe(true);
    expect(result.untrustedWorld).toMatchObject([{ sid: "s-1-1-0", canRead: true, canWrite: false }]);
    expect(result.entries).toHaveLength(1);
  });

  it("preserves a structured query failure as the original diagnostic cause", async () => {
    const original = Object.assign(new Error("descriptor query denied"), { code: 9, signal: null, stderr: "query failed\n" });
    const result = await inspectWindowsAcl("C:\\fixture", { exec: async () => { throw original; } });
    expect(result).toMatchObject({ ok: false, errorDetail: { command: expect.stringContaining("powershell.exe"), exitCode: 9, stderr: "query failed\\u000a" } });
    expect(result.errorCause).toBe(original);
  });
});
