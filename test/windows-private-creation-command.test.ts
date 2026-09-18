import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERMISSION_EXEC_TIMEOUT_MS } from "../src/permission-exec.js";
import {
  createPrivateWindowsDirectoryCommand,
  createPrivateWindowsDirectoryCommandSync,
  inspectWindowsDirectoryCommand,
  inspectWindowsDirectoryCommandSync,
  protectPrivateWindowsFileCommand,
  protectPrivateWindowsFileCommandSync,
  verifyPrivateWindowsFileCommand,
  verifyPrivateWindowsFileCommandSync,
} from "../src/windows-security-command.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(), spawnSync: vi.fn(),
}));

const parentIdentity = "0123456789abcdef:0123456789abcdeffedcba9876543210";
const fileIdentity = "fedcba9876543210:fedcba98765432100123456789abcdef";
const targetPath = String.raw`C:\private\é-🦀';Get-Process;#`;
const script = fileURLToPath(new URL("../src/windows-security-bridge.ps1", import.meta.url));
const commandPrefix = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-Operation"];

function syncOutput(stdout: string) {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, stdout, stderr: "" } as ReturnType<typeof spawnSync>);
}

function syncReply(result: unknown) {
  syncOutput(JSON.stringify({ ok: true, result }));
}

function childReply(result: unknown, deferred = false) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => false), unref: vi.fn(),
  });
  const complete = () => {
    child.stdout.end(JSON.stringify({ ok: true, result }));
    child.stderr.end();
    child.emit("close", 0, null);
  };
  vi.mocked(spawn).mockImplementation(() => {
    if (!deferred) queueMicrotask(complete);
    return child as unknown as ReturnType<typeof spawn>;
  });
  return child;
}

const variants = [
  {
    name: "sync", create: createPrivateWindowsDirectoryCommandSync,
    inspect: inspectWindowsDirectoryCommandSync, protect: protectPrivateWindowsFileCommandSync,
    verify: verifyPrivateWindowsFileCommandSync, reply: syncReply, spawned: spawnSync,
  },
  {
    name: "async", create: createPrivateWindowsDirectoryCommand,
    inspect: inspectWindowsDirectoryCommand, protect: protectPrivateWindowsFileCommand,
    verify: verifyPrivateWindowsFileCommand, reply: childReply, spawned: spawn,
  },
] as const;

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe.each(variants)("Windows private-creation command protocol ($name)", variant => {
  it("keeps creation paths and expected parent identities out of script arguments", async () => {
    variant.reply({ created: true, identity: fileIdentity });
    expect(await variant.create(targetPath, parentIdentity)).toEqual({ identity: fileIdentity });
    expect(variant.spawned).toHaveBeenCalledOnce();
    expect(vi.mocked(variant.spawned).mock.calls[0]?.[1]).toEqual([...commandPrefix, "create"]);
    expect(vi.mocked(variant.spawned).mock.calls[0]?.[2]).toMatchObject({
      env: { FS_SAFE_WINDOWS_SECURITY_PATH: targetPath, FS_SAFE_WINDOWS_SECURITY_PARENT_IDENTITY: parentIdentity },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
  });

  it.each([undefined, null, "00000001:0000000000000002", fileIdentity.toUpperCase(), `${fileIdentity}\n`])(
    "reports creation as unconfirmed when its identity is missing or malformed: %j", async identity => {
      variant.reply({ created: true, identity });
      await expect(Promise.resolve().then(() => variant.create(targetPath, parentIdentity))).rejects.toMatchObject({
        code: "permission-unverified", creationOutcome: "unconfirmed",
      });
      expect(variant.spawned).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])("passes the requested directory privacy policy: %s", async requirePrivate => {
    variant.reply({ identity: parentIdentity });
    expect(await variant.inspect(targetPath, requirePrivate)).toEqual({ identity: parentIdentity });
    expect(vi.mocked(variant.spawned).mock.calls[0]?.[1]).toEqual([...commandPrefix, "directory"]);
    expect(vi.mocked(variant.spawned).mock.calls[0]?.[2]).toMatchObject({
      env: { FS_SAFE_WINDOWS_SECURITY_PATH: targetPath, FS_SAFE_WINDOWS_SECURITY_REQUIRE_PRIVATE: requirePrivate ? "1" : "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("inherits the borrowed file descriptor while protecting the expected parent", async () => {
    variant.reply({ identity: fileIdentity });
    expect(await variant.protect(73, targetPath, parentIdentity)).toEqual({ identity: fileIdentity });
    expect(vi.mocked(variant.spawned).mock.calls[0]?.[1]).toEqual([...commandPrefix, "protect-file"]);
    expect(vi.mocked(variant.spawned).mock.calls[0]?.[2]).toMatchObject({
      env: { FS_SAFE_WINDOWS_SECURITY_PATH: targetPath, FS_SAFE_WINDOWS_SECURITY_PARENT_IDENTITY: parentIdentity },
      stdio: [73, "pipe", "pipe"],
    });
  });

  it.each([undefined, 2])("verifies the full file identity and expected link count: %s", async expectedLinks => {
    variant.reply({ identity: fileIdentity });
    await variant.verify(73, targetPath, fileIdentity, parentIdentity, expectedLinks);
    expect(vi.mocked(variant.spawned).mock.calls[0]?.[1]).toEqual([...commandPrefix, "verify-file"]);
    expect(vi.mocked(variant.spawned).mock.calls[0]?.[2]).toMatchObject({
      env: {
        FS_SAFE_WINDOWS_SECURITY_PATH: targetPath, FS_SAFE_WINDOWS_SECURITY_PARENT_IDENTITY: parentIdentity,
        FS_SAFE_WINDOWS_SECURITY_FILE_IDENTITY: fileIdentity, FS_SAFE_WINDOWS_SECURITY_EXPECTED_LINKS: String(expectedLinks ?? 1),
      },
      stdio: [73, "pipe", "pipe"],
    });
  });

  it.each([
    null, {}, { identity: 42 }, { identity: "00000001:0000000000000002" },
    { identity: fileIdentity.toUpperCase() }, { identity: `${fileIdentity}\n` },
    { identity: fileIdentity.slice(0, -1) },
  ])("rejects incomplete or noncanonical identity receipts: %j", async response => {
    for (const operation of [
      () => variant.inspect(targetPath, true),
      () => variant.protect(73, targetPath, parentIdentity),
      () => variant.verify(73, targetPath, fileIdentity, parentIdentity),
    ]) {
      variant.reply(response);
      await expect(Promise.resolve().then(() => operation())).rejects.toMatchObject({ code: "permission-unverified" });
    }
  });

  it("rejects a well-formed verification receipt for a different file", async () => {
    variant.reply({ identity: parentIdentity });
    await expect(Promise.resolve().then(() => variant.verify(73, targetPath, fileIdentity, parentIdentity))).rejects.toThrow();
  });

  it.each([-1, 1.5, Number.NaN, 0x8000_0000])("rejects invalid borrowed descriptors before spawning: %s", async fd => {
    for (const operation of [
      () => variant.protect(fd, targetPath, parentIdentity),
      () => variant.verify(fd, targetPath, fileIdentity, parentIdentity),
    ]) await expect(Promise.resolve().then(() => operation())).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each(["", "00000001:0000000000000002", fileIdentity.toUpperCase(), `${fileIdentity}\0`])(
    "rejects invalid expected identities before spawning: %j", async invalidIdentity => {
      for (const operation of [
        () => variant.create(targetPath, invalidIdentity),
        () => variant.protect(73, targetPath, invalidIdentity),
        () => variant.verify(73, targetPath, invalidIdentity, parentIdentity),
        () => variant.verify(73, targetPath, fileIdentity, invalidIdentity),
      ]) await expect(Promise.resolve().then(() => operation())).rejects.toThrow();
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, Number.NaN, 0x1_0000_0000])("rejects invalid link counts before spawning: %s", async links => {
    await expect(Promise.resolve().then(() => variant.verify(73, targetPath, fileIdentity, parentIdentity, links))).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("rejects NUL paths before any bridge operation starts", async () => {
    const invalidPath = `${targetPath}\0suffix`;
    for (const operation of [
      () => variant.create(invalidPath, parentIdentity),
      () => variant.inspect(invalidPath, true),
      () => variant.protect(73, invalidPath, parentIdentity),
      () => variant.verify(73, invalidPath, fileIdentity, parentIdentity),
    ]) await expect(Promise.resolve().then(() => operation())).rejects.toMatchObject({ code: "EINVAL" });
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe("synchronous private-directory creation outcomes", () => {
  it.each(["not json", '{"ok":true}', '{"ok":true,"result":{"created":false}}'])(
    "retains an unconfirmed creation outcome for an unusable receipt: %s", stdout => {
      syncOutput(stdout);
      expect(() => createPrivateWindowsDirectoryCommandSync(targetPath)).toThrow(expect.objectContaining({
        code: "permission-unverified", creationOutcome: "unconfirmed",
      }));
      expect(spawnSync).toHaveBeenCalledOnce();
    },
  );

  it("reports a synchronous timeout as unconfirmed even if stdout claims creation succeeded", () => {
    const cause = Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" });
    vi.mocked(spawnSync).mockReturnValue({
      status: null, signal: "SIGKILL", error: cause,
      stdout: JSON.stringify({ ok: true, result: { created: true, identity: fileIdentity } }), stderr: "",
    } as ReturnType<typeof spawnSync>);
    expect(() => createPrivateWindowsDirectoryCommandSync(targetPath)).toThrow(expect.objectContaining({
      timedOut: true, signal: "SIGKILL", creationOutcome: "unconfirmed",
    }));
    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]).toMatchObject({
      timeout: DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, killSignal: "SIGKILL",
    });
  });

  it("keeps a confirmed EEXIST collision distinct from an unconfirmed creation", () => {
    syncOutput('{"ok":false,"code":"EEXIST","message":"directory already exists"}');
    let failure: unknown;
    try { createPrivateWindowsDirectoryCommandSync(targetPath); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "EEXIST", message: "directory already exists" });
    expect(failure).not.toHaveProperty("creationOutcome");
    expect(spawnSync).toHaveBeenCalledOnce();
  });
});

describe("private-file bridge descriptor lifetime", () => {
  it("waits for command close and keeps the caller's descriptor open after success and rejection", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-bridge-fd-"));
    const fd = fs.openSync(path.join(directory, "private-file"), "wx+", 0o600);
    try {
      const original = fs.fstatSync(fd, { bigint: true });
      const child = childReply({ identity: fileIdentity }, true);
      const result = protectPrivateWindowsFileCommand(fd, targetPath, parentIdentity);
      let settled = false;
      const observed = result.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
      try {
        child.stdout.end(JSON.stringify({ ok: true, result: { identity: fileIdentity } }));
        child.stderr.end();
        child.emit("exit", 0, null);
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(fs.fstatSync(fd, { bigint: true })).toMatchObject({ dev: original.dev, ino: original.ino });
      } finally { child.emit("close", 0, null); }
      await expect(observed).resolves.toEqual({ identity: fileIdentity });
      for (const variant of variants) {
        variant.reply({ identity: fileIdentity });
        await variant.verify(fd, targetPath, fileIdentity, parentIdentity);
        variant.reply({ identity: "incomplete" });
        await expect(Promise.resolve().then(() => variant.protect(fd, targetPath, parentIdentity))).rejects.toThrow();
        expect(fs.fstatSync(fd, { bigint: true })).toMatchObject({ dev: original.dev, ino: original.ino });
      }
    } finally {
      fs.closeSync(fd);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
