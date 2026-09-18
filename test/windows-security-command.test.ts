import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeFallbackWarningsForTest } from "../src/native-fallback-warning.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { readOwnerAndDacl } from "../src/owner-dacl.js";
import { createPrivateDirectory } from "../src/private-directory.js";
import { inspectSecureWindowsFile } from "../src/secure-file-windows.js";
import { DEFAULT_PERMISSION_EXEC_TIMEOUT_MS } from "../src/permission-exec.js";
import { createPrivateWindowsDirectoryCommand, inspectWindowsDescriptorCommand, readWindowsSecurityFactsCommand } from "../src/windows-security-command.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(), spawnSync: vi.fn(),
}));

const flags = (raw = 0) => ({
  raw, objectInherit: Boolean(raw & 1), containerInherit: Boolean(raw & 2), noPropagateInherit: Boolean(raw & 4),
  inheritOnly: Boolean(raw & 8), inherited: Boolean(raw & 16), successfulAccess: Boolean(raw & 64), failedAccess: Boolean(raw & 128),
});
const ace = (sid = "s-1-5-21-42", mask = 0x1f01ff, raw = 0) => ({ sid, mask, aceType: "allow", flags: flags(raw) });
const security = (overrides: Record<string, unknown> = {}) => ({
  ownerSid: "s-1-5-21-42", currentUserSid: "s-1-5-21-42", daclPresent: true, daclProtected: true,
  isLocal: true, aceListComplete: true, unsupportedAceTypes: [], aces: [ace()], ...overrides,
});
const receipt = (overrides: Record<string, unknown> = {}) => ({ identity: "00000001:0000000000000002", security: security(), ...overrides });

function syncReply(result: unknown) {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, stdout: JSON.stringify({ ok: true, result }), stderr: "" } as ReturnType<typeof spawnSync>);
}

function childReply(result: unknown, options: { defer?: boolean; envelope?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  child.kill.mockImplementation(() => {
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    return true;
  });
  const complete = () => {
    child.stdout.end(JSON.stringify(options.envelope ? result : { ok: true, result }));
    child.stderr.end();
    child.emit("close", 0, null);
  };
  vi.mocked(spawn).mockImplementation(() => {
    if (!options.defer) queueMicrotask(complete);
    return child as unknown as ReturnType<typeof spawn>;
  });
  return { child, complete };
}

beforeEach(() => {
  vi.clearAllMocks();
  configureFsSafeNative({ mode: "off" });
  __resetNativeFallbackWarningsForTest();
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __resetNativeFallbackWarningsForTest();
});

describe("Windows security command facts", () => {
  it("preserves ordered raw ACEs, all flags, unsigned masks, and unsupported types", () => {
    const aces = [ace("s-1-5-21-7", 0xffff_ffff, 0xdf), { ...ace(), aceType: "deny" }];
    syncReply(security({ aces, aceListComplete: false, unsupportedAceTypes: [5, 9] }));
    const facts = readWindowsSecurityFactsCommand(String.raw`C:\private\é-🦀`);
    expect(facts).toMatchObject({ aces, aceListComplete: false, unsupportedAceTypes: [5, 9], fallbackRequired: true });
    expect(vi.mocked(spawnSync).mock.calls[0]?.[0]).toMatch(/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]).toMatchObject({ env: { FS_SAFE_WINDOWS_SECURITY_PATH: String.raw`C:\private\é-🦀` } });
  });

  it("does not trust TrustedInstaller or subtract deny ACEs from broad grants", () => {
    const installer = "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    syncReply(security({ aces: [{ ...ace(installer, 1), aceType: "deny" }, ace(installer, 1)] }));
    expect(readWindowsSecurityFactsCommand("C:\\private")).toMatchObject({ groupReadable: true, worldReadable: false });
  });

  it.each([true, false])("distinguishes empty and null DACLs: present=%s", daclPresent => {
    syncReply(security({ daclPresent, aces: [] }));
    expect(readWindowsSecurityFactsCommand("C:\\private")).toMatchObject({
      daclPresent, worldReadable: !daclPresent, worldWritable: !daclPresent,
    });
  });

  it.each([
    { isLocal: undefined }, { currentUserSid: "bad" }, { aces: [ace("bad")] },
    { aces: [{ ...ace(), mask: -1 }] }, { aces: [{ ...ace(), flags: { ...flags(), inherited: true } }] },
    { daclPresent: false }, { unsupportedAceTypes: [5] },
  ])("rejects incomplete or inconsistent facts %j", overrides => {
    syncReply(security(overrides));
    expect(() => readWindowsSecurityFactsCommand("C:\\private")).toThrow(expect.objectContaining({ code: "permission-unverified" }));
  });

  it("retains typed OS failures instead of producing empty facts", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, stdout: JSON.stringify({ ok: false, code: "EACCES", message: "read owner and DACL failed" }), stderr: "" } as ReturnType<typeof spawnSync>);
    expect(() => readWindowsSecurityFactsCommand("C:\\private")).toThrow(expect.objectContaining({ code: "EACCES" }));
  });

  it("does not return creation success from a malformed command receipt", async () => {
    childReply({ created: false });
    await expect(createPrivateWindowsDirectoryCommand("C:\\private")).rejects.toMatchObject({ code: "permission-unverified" });
  });

  it("inherits the borrowed fd and waits for both output streams and exit", async () => {
    const { complete } = childReply(receipt(), { defer: true });
    const result = inspectWindowsDescriptorCommand(73);
    let settled = false;
    void result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({ stdio: [73, "pipe", "pipe"], windowsHide: true });
    complete();
    await expect(result).resolves.toMatchObject({ identity: receipt().identity, security: { ownerClass: "current-user" } });
  });

  it("joins a timed-out command before rejecting", async () => {
    vi.useFakeTimers();
    const { child } = childReply(receipt(), { defer: true });
    const result = inspectWindowsDescriptorCommand(73);
    const rejection = expect(result).rejects.toMatchObject({ timedOut: true, signal: "SIGKILL" });
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_EXEC_TIMEOUT_MS);
    await rejection;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("bounds captured command output", async () => {
    const { child } = childReply(receipt(), { defer: true });
    const result = inspectWindowsDescriptorCommand(73);
    child.stdout.write(Buffer.alloc(1024 * 1024 + 1, 65));
    await expect(result).rejects.toMatchObject({ signal: "SIGKILL" });
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

describe("Windows fallback admission", () => {
  const params = { fd: 73, identity: { dev: 1n, ino: 2n }, stat: { mode: 0o600, isDirectory: () => false } as fs.Stats };

  it.each(["off", "auto"] as const)("reads through the descriptor fallback in %s mode with a missing package", async mode => {
    configureFsSafeNative({ mode });
    __setNativeLoaderForTest(() => { throw new Error("package omitted"); });
    childReply(receipt());
    await expect(inspectSecureWindowsFile(params)).resolves.toMatchObject({ source: "windows-acl", ownerTrusted: true });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("retains require-mode rejection for a missing package without starting any command", async () => {
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => { throw new Error("package omitted"); });
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    try {
      expect(() => readOwnerAndDacl("C:\\private")).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
      await expect(createPrivateDirectory("C:\\private")).rejects.toMatchObject({ code: "helper-unavailable" });
      await expect(inspectSecureWindowsFile(params)).rejects.toMatchObject({ code: "permission-unverified" });
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
      expect(process.emitWarning).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });

  it("allows capability fallback in require mode after the addon loaded successfully", async () => {
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn() }) as unknown as NativeBinding);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    try {
      syncReply(security());
      expect(readOwnerAndDacl("C:\\private")).toMatchObject({ status: "supported", complete: true });
      childReply({ created: true });
      await createPrivateDirectory("C:\\private");
      childReply(receipt());
      await expect(inspectSecureWindowsFile(params)).resolves.toMatchObject({ source: "windows-acl", ownerTrusted: true });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawnSync).toHaveBeenCalledOnce();
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });

  it("uses a stale helper's missing capability without calling its pathname query", async () => {
    configureFsSafeNative({ mode: "auto" });
    const legacy = vi.fn();
    __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn(), readOwnerAndDacl: legacy }) as unknown as NativeBinding);
    childReply(receipt());
    await inspectSecureWindowsFile(params);
    expect(legacy).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("does not fall back after a native descriptor error", async () => {
    configureFsSafeNative({ mode: "auto" });
    const cause = Object.assign(new Error("native denied"), { code: "EACCES" });
    __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn(), inspectWindowsSecureFileHandle: () => { throw cause; } }) as unknown as NativeBinding);
    await expect(inspectSecureWindowsFile(params)).rejects.toMatchObject({ code: "permission-unverified", cause });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["path-mismatch", { identity: "00000001:0000000000000003" }],
    ["permission-unverified", { security: security({ isLocal: false }) }],
    ["permission-unverified", { security: security({ aceListComplete: false, unsupportedAceTypes: [5] }) }],
  ])("rejects unsafe command observations with %s", async (code, overrides) => {
    childReply(receipt(overrides as Record<string, unknown>));
    await expect(inspectSecureWindowsFile(params)).rejects.toMatchObject({ code });
  });

  it("warns once without exposing caller paths", async () => {
    childReply({ created: true });
    await createPrivateDirectory("C:\\confidential-one", { platform: "win32" });
    childReply({ created: true });
    await createPrivateDirectory("C:\\confidential-two", { platform: "win32" });
    expect(process.emitWarning).toHaveBeenCalledOnce();
    expect(String(vi.mocked(process.emitWarning).mock.calls[0]?.[0])).not.toContain("confidential");
  });

  it("rejects Windows aliases before starting a command", async () => {
    await expect(createPrivateDirectory("C:\\parent.\\private", { platform: "win32" })).rejects.toMatchObject({ code: "EINVAL" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps native creation errors terminal", async () => {
    configureFsSafeNative({ mode: "auto" });
    const cause = Object.assign(new Error("exists"), { code: "EEXIST" });
    __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn(), createPrivateDirectory: () => { throw cause; } }) as unknown as NativeBinding);
    await expect(createPrivateDirectory("C:\\private", { platform: "win32" })).rejects.toBe(cause);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("adapts fallback raw facts to the public owner/DACL contract", () => {
    syncReply(security());
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    try {
      expect(readOwnerAndDacl("C:\\private")).toMatchObject({ status: "supported", complete: true, aces: [ace()] });
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });
});
