import type { Stats } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeBinding, NativeWindowsSecurityFacts } from "../src/native-binding.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeFallbackWarningsForTest } from "../src/native-fallback-warning.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { readOwnerAndDacl } from "../src/owner-dacl.js";
import { createPrivateDirectory } from "../src/private-directory.js";
import { inspectSecureWindowsFile } from "../src/secure-file-windows.js";
import * as command from "../src/windows-security-command.js";

vi.mock("../src/windows-security-command.js", () => ({
  readWindowsSecurityFactsCommand: vi.fn(),
  createPrivateWindowsDirectoryCommand: vi.fn(),
  inspectWindowsDescriptorCommand: vi.fn(),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const privatePath = String.raw`C:\confidential\private`;
const params = {
  fd: 73,
  identity: { dev: 1n, ino: 2n },
  stat: { mode: 0o600, isDirectory: () => false } as Stats,
};

function security(overrides: Partial<NativeWindowsSecurityFacts> = {}): NativeWindowsSecurityFacts {
  return {
    ownerSid: "s-1-5-21-42", currentUserSid: "s-1-5-21-42", ownerClass: "current-user",
    worldReadable: false, worldWritable: false, groupReadable: false, groupWritable: false,
    fallbackRequired: false, daclPresent: true, isLocal: true, aceListComplete: true,
    unsupportedAceTypes: [], aces: [], ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}): void {
  __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn(), ...overrides }) as unknown as NativeBinding);
}

function noFallback(): void {
  expect(command.readWindowsSecurityFactsCommand).not.toHaveBeenCalled();
  expect(command.createPrivateWindowsDirectoryCommand).not.toHaveBeenCalled();
  expect(command.inspectWindowsDescriptorCommand).not.toHaveBeenCalled();
  expect(process.emitWarning).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetNativeFallbackWarningsForTest();
  configureFsSafeNative({ mode: "require" });
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeFallbackWarningsForTest();
});

describe("Windows security native policy", () => {
  it.each([undefined, null, true, "stale"])("requires each native capability to be callable (%j)", async missing => {
    binding({
      readOwnerAndDacl: missing,
      createPrivateDirectory: missing,
      inspectWindowsSecureFileHandle: missing,
    });
    expect(() => readOwnerAndDacl(privatePath)).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
    await expect(createPrivateDirectory(privatePath)).rejects.toMatchObject({ code: "helper-unavailable" });
    await expect(inspectSecureWindowsFile(params)).rejects.toMatchObject({ code: "permission-unverified" });
    noFallback();
  });

  it("retains a missing binding's cause without warning or dispatching commands", async () => {
    const cause = new Error("private native loader detail");
    __setNativeLoaderForTest(() => { throw cause; });
    expect(() => readOwnerAndDacl(privatePath)).toThrow(expect.objectContaining({ code: "helper-unavailable", cause }));
    await expect(createPrivateDirectory(privatePath)).rejects.toMatchObject({ code: "helper-unavailable", cause });
    await expect(inspectSecureWindowsFile(params)).rejects.toMatchObject({
      code: "permission-unverified", cause: { code: "helper-unavailable", cause },
    });
    noFallback();
  });

  for (const mode of ["auto", "require"] as const) {
    it.each(["EACCES", "EIO", "EEXIST"])(`preserves native %s failures in ${mode} mode`, async code => {
      configureFsSafeNative({ mode });
      const cause = Object.assign(new Error("native operation failed"), { code });
      const fail = () => { throw cause; };
      const read = vi.fn(fail);
      const create = vi.fn(fail);
      const inspect = vi.fn(fail);
      binding({ readOwnerAndDacl: read, createPrivateDirectory: create, inspectWindowsSecureFileHandle: inspect });
      expect(() => readOwnerAndDacl(privatePath)).toThrow(cause);
      await expect(createPrivateDirectory(privatePath)).rejects.toBe(cause);
      await expect(inspectSecureWindowsFile(params)).rejects.toMatchObject({ code: "permission-unverified", cause });
      expect(read).toHaveBeenCalledExactlyOnceWith(privatePath);
      expect(create).toHaveBeenCalledExactlyOnceWith(privatePath);
      expect(inspect).toHaveBeenCalledExactlyOnceWith(params.fd);
      noFallback();
    });

    it.each([
      ["path-mismatch", { identity: "00000001:0000000000000003", security: security() }],
      ["path-mismatch", { identity: "malformed", security: security() }],
      ["permission-unverified", null],
      ["permission-unverified", { identity: "00000001:0000000000000002", security: security({ aceListComplete: false }) }],
      ["permission-unverified", { identity: "00000001:0000000000000002", security: security({ isLocal: false }) }],
      ["permission-unverified", { identity: "00000001:0000000000000002", security: security({ worldReadable: true }) }],
    ] as const)(`keeps invalid native descriptor facts terminal in ${mode}: %s`, async (code, result) => {
      configureFsSafeNative({ mode });
      const inspect = vi.fn(() => result);
      binding({ inspectWindowsSecureFileHandle: inspect });
      await expect(inspectSecureWindowsFile(params)).rejects.toMatchObject({ code });
      expect(inspect).toHaveBeenCalledExactlyOnceWith(params.fd);
      noFallback();
    });
  }

  it.each(["auto", "off"] as const)("warns once per fallback capability without paths in %s mode", async mode => {
    configureFsSafeNative({ mode });
    binding();
    vi.mocked(command.readWindowsSecurityFactsCommand).mockReturnValue(security());
    vi.mocked(command.createPrivateWindowsDirectoryCommand).mockResolvedValue({
      identity: "0000000000000001:00000000000000000000000000000002",
    });
    vi.mocked(command.inspectWindowsDescriptorCommand).mockResolvedValue({
      identity: "00000001:0000000000000002", security: security(),
    });
    for (let index = 0; index < 2; index++) {
      readOwnerAndDacl(privatePath);
      await createPrivateDirectory(privatePath);
      await inspectSecureWindowsFile(params);
    }
    expect(command.readWindowsSecurityFactsCommand).toHaveBeenCalledTimes(2);
    expect(command.createPrivateWindowsDirectoryCommand).toHaveBeenCalledTimes(2);
    expect(command.inspectWindowsDescriptorCommand).toHaveBeenCalledTimes(2);
    const warnings = vi.mocked(process.emitWarning).mock.calls;
    expect(warnings).toHaveLength(3);
    for (const [index, feature] of ["windows-owner-dacl", "windows-private-directory", "windows-secure-file"].entries()) {
      expect(warnings[index]).toEqual([
        expect.stringContaining(feature), { code: "FS_SAFE_NATIVE_FALLBACK", type: "FsSafeWarning" },
      ]);
      expect(String(warnings[index]?.[0])).not.toContain("confidential");
    }
  });
});
