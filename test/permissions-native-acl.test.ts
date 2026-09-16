import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import type { NativeWindowsSecurityFacts } from "../src/native-binding.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { executePermissionCommand } from "../src/permission-exec.js";
import { inspectWindowsAcl } from "../src/permissions.js";

vi.mock("../src/permission-exec.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/permission-exec.js")>(),
  executePermissionCommand: vi.fn(),
}));

const exec = vi.mocked(executePermissionCommand);
const { tempRoot } = useTempDirs();
let target: string;
const flags = {
  raw: 16, objectInherit: false, containerInherit: false, noPropagateInherit: false,
  inheritOnly: false, inherited: true, successfulAccess: false, failedAccess: false,
};
const ace = (sid: string, mask: number, aceType = "allow", inheritOnly = false) => ({
  sid, mask, aceType, flags: { ...flags, inheritOnly },
});

function facts(override: Partial<NativeWindowsSecurityFacts> = {}): NativeWindowsSecurityFacts {
  return {
    ownerSid: "s-1-5-21-42", currentUserSid: "s-1-5-21-42", ownerClass: "current-user",
    worldWritable: false, groupWritable: false, worldReadable: false, groupReadable: false,
    fallbackRequired: false, daclPresent: true, isLocal: true, aceListComplete: true,
    unsupportedAceTypes: [], aces: [], ...override,
  };
}

function queryOutput(value: NativeWindowsSecurityFacts) {
  return { stdout: JSON.stringify({
    ownerSid: value.ownerSid, currentUserSid: value.currentUserSid,
    complete: true, daclPresent: value.daclPresent,
    aces: value.aces.map(entry => ({
      sid: entry.sid, mask: entry.mask, deny: entry.aceType === "deny",
      inheritOnly: entry.flags.inheritOnly,
    })),
  }), stderr: "" };
}

function install(value: NativeWindowsSecurityFacts) {
  const readOwnerAndDacl = vi.fn(() => value);
  __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn(), readOwnerAndDacl }) as unknown as NativeBinding);
  exec.mockResolvedValue(queryOutput(value));
  return readOwnerAndDacl;
}

beforeEach(async () => {
  configureFsSafeNative({ mode: "require" });
  target = path.join(await tempRoot("fs-safe-native-acl-"), "ordinary.txt");
  await fs.writeFile(target, "ordinary ACL fixture");
});
afterEach(() => {
  vi.resetAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe.skipIf(process.platform !== "win32")("native advanced Windows ACL inspection", () => {
  it("rejects namespace aliases before native loading, stat, or command fallback", async () => {
    const readOwnerAndDacl = vi.fn(() => facts());
    const load = vi.fn(() => ({ closeOwnedFd: vi.fn(), readOwnerAndDacl }) as unknown as NativeBinding);
    __setNativeLoaderForTest(load);
    const lstat = vi.spyOn(fsSync, "lstatSync");

    await expect(inspectWindowsAcl(`${target}:stream`)).resolves.toMatchObject({
      ok: false,
      entries: [],
      error: expect.stringContaining("Windows filesystem namespace alias"),
    });

    expect(load).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();
    expect(readOwnerAndDacl).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", facts()],
    ["null", facts({ daclPresent: false })],
    ["ordinary rules", facts({ aces: [
      ace("s-1-5-21-42", 0x001f01ff),
      ace("s-1-5-18", 0x001f01ff),
      ace("s-1-5-32-544", 0x001f01ff),
      ace("s-1-1-0", 0x00020000),
      ace("s-1-2-0", 1),
      ace("s-1-5-21-99", 0x40000000),
      ace("s-1-1-0", 0x001f01ff, "deny"),
      ace("s-1-5-32-545", 0x001f01ff, "allow", true),
    ] })],
  ] as const)("classifies %s DACL facts identically without starting a process", async (_name, value) => {
    const read = install(value);
    const native = await inspectWindowsAcl(target);
    expect(exec).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(target);
    const fallback = await inspectWindowsAcl(target, { exec });
    expect(native).toEqual(fallback);
    expect(native.ok).toBe(true);
    expect(exec).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
  });

  it("applies the explicit current-user override to native ACE facts", async () => {
    install(facts({ aces: [ace("s-1-5-21-99", 1)] }));
    const result = await inspectWindowsAcl(target, { currentUserSid: " *S-1-5-21-99 " });
    expect(result.trusted).toMatchObject([{ sid: "s-1-5-21-99", canRead: true }]);
    expect(result.untrustedGroup).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    { fallbackRequired: true },
    { isLocal: false },
    { aceListComplete: false },
    { unsupportedAceTypes: [9] },
    { aces: [{ ...ace("s-1-5-21-42", 1), flags: { ...flags, inherited: false, raw: 0 } }] },
    { aces: [ace("s-1-5-21-42", 0)] },
  ])("uses the complete fallback instead of partial native facts: %j", async override => {
    const read = install(facts(override));
    exec.mockResolvedValue(queryOutput(facts({ aces: [ace("s-1-1-0", 1)] })));
    const result = await inspectWindowsAcl(target);
    expect(read).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledOnce();
    expect(result.untrustedWorld).toMatchObject([{ sid: "s-1-1-0", canRead: true }]);
  });

  it.each(["off", "auto", "require"] as const)("retains fallback with an unavailable helper in %s mode", async mode => {
    configureFsSafeNative({ mode });
    __setNativeLoaderForTest(() => { throw new Error("optional helper unavailable"); });
    exec.mockResolvedValue(queryOutput(facts()));
    await expect(inspectWindowsAcl(target)).resolves.toMatchObject({ ok: true, entries: [] });
    expect(exec).toHaveBeenCalledOnce();
  });

  it("preserves the fallback error and original diagnostic cause after native failure", async () => {
    const read = install(facts());
    read.mockImplementation(() => { throw new Error("native query unavailable"); });
    const original = Object.assign(new Error("descriptor query denied"), { code: 5, stderr: "denied\n" });
    exec.mockRejectedValue(original);
    const result = await inspectWindowsAcl(target);
    expect(result).toMatchObject({
      ok: false, entries: [], errorDetail: { exitCode: 5, stderr: "denied\\u000a" },
    });
    expect(result.errorCause).toBe(original);
  });

  it.each(["env", "exec"] as const)("honors an explicit %s injection without reading native facts", async option => {
    const read = install(facts());
    const options = option === "env" ? { env: { SystemRoot: "D:\\Windows" } } : { exec };
    await expect(inspectWindowsAcl(target, options)).resolves.toMatchObject({ ok: true });
    expect(read).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledOnce();
    if (option === "env") {
      expect(exec.mock.calls[0]?.[0]).toBe("D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    }
  });

  it("reports explicit principal translation failure before either reader runs", async () => {
    const read = install(facts());
    await expect(inspectWindowsAcl(target, { principalTranslationFailed: true })).resolves.toMatchObject({
      ok: false, entries: [], error: "Error: Windows ACL principal SID translation failed",
    });
    expect(read).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
