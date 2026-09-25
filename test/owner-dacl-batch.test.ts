import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { __resetNativeFallbackWarningsForTest } from "../src/native-fallback-warning.js";
import { readOwnerAndDaclBatch } from "../src/owner-dacl-batch.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const firstPath = String.raw`C:\staging\é-🦀`;
const secondPath = String.raw`C:\staging\';Get-Process;#`;

function security(mask = 0x1f01ff) {
  return {
    ownerSid: "s-1-5-21-42", currentUserSid: "s-1-5-21-42", daclPresent: true,
    isLocal: true, aceListComplete: true, unsupportedAceTypes: [],
    aces: [{
      sid: "s-1-5-21-7", mask, aceType: "allow",
      flags: {
        raw: 8, objectInherit: false, containerInherit: false, noPropagateInherit: false,
        inheritOnly: true, inherited: false, successfulAccess: false, failedAccess: false,
      },
    }],
  };
}

function commandChild() {
  const input: Buffer[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => false), unref: vi.fn(),
  });
  child.stdin.on("data", (chunk: Buffer) => input.push(chunk));
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return {
    child,
    input: () => JSON.parse(Buffer.concat(input).toString("utf8")),
    finish: (reply: unknown) => {
      child.stdout.end(JSON.stringify(reply));
      child.stderr.end();
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    },
  };
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  // node:path keeps its host implementation when process.platform is simulated.
  if (platform.value !== "win32") {
    vi.spyOn(path, "isAbsolute").mockImplementation(path.win32.isAbsolute);
  }
  configureFsSafeNative({ mode: "off" });
  __resetNativeFallbackWarningsForTest();
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __resetNativeFallbackWarningsForTest();
});

describe("readOwnerAndDaclBatch", () => {
  it("returns ordered facts and duplicates through one PowerShell process", async () => {
    const child = commandChild();
    const paths = [firstPath, secondPath, firstPath];
    const pending = readOwnerAndDaclBatch(paths);
    const masks = [1, 0xffff_ffff, 1];
    child.finish({ ok: true, result: paths.map((path, index) => ({ path, security: security(masks[index]) })) });
    const result = await pending;
    expect(child.input()).toEqual(paths);
    expect(result).toEqual(masks.map(mask => ({
      status: "supported", ownerSid: "s-1-5-21-42", currentUserSid: "s-1-5-21-42",
      daclPresent: true, isLocal: true, complete: true, unsupportedAceTypes: [], aces: security(mask).aces,
    })));
    expect(spawn).toHaveBeenCalledOnce();
    const [file, args] = vi.mocked(spawn).mock.calls[0]!;
    expect(file).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    expect(args).toContain("paths");
    expect(args).not.toContain(firstPath);
    expect(args).not.toContain(secondPath);
  });

  it("isolates native queries and captures paths, timeout and configured mode before awaiting", async () => {
    const nativeQuery = vi.fn(() => { throw new Error("parent must not query"); });
    __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn(), readOwnerAndDacl: nativeQuery }) as unknown as NativeBinding);
    configureFsSafeNative({ mode: "auto" });
    vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
    vi.stubEnv("NODE_OPTIONS", "--require untrusted-preload");
    vi.stubEnv("Node_Options", "--require mixed-case-preload");
    vi.stubEnv("node_options", "--require lowercase-preload");
    vi.stubEnv("Node_Path", "untrusted-modules");
    vi.stubEnv("fs_safe_owner_dacl_batch_mode", "off");
    const child = commandChild();
    const paths = [firstPath];
    const timeout = vi.fn(() => 60_000);
    const pending = readOwnerAndDaclBatch(paths, { get timeoutMs() { return timeout(); } });
    paths[0] = secondPath;
    configureFsSafeNative({ mode: "off" });
    child.finish({ ok: true, result: [{ path: firstPath, security: security() }] });
    expect(await pending).toHaveLength(1);
    expect(child.input()).toEqual([firstPath]);
    expect(timeout).toHaveBeenCalledOnce();
    expect(nativeQuery).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    const [file, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(file).toBe(process.execPath);
    expect(args?.at(-1)).toMatch(/owner-dacl-batch-worker\.js$/);
    expect(options).toMatchObject({ env: { FS_SAFE_OWNER_DACL_BATCH_MODE: "auto" } });
    expect(Object.keys(options?.env ?? {}).filter(key =>
      ["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase()))).toEqual([]);
    expect(Object.keys(options?.env ?? {}).filter(key =>
      key.toUpperCase() === "FS_SAFE_OWNER_DACL_BATCH_MODE")).toEqual(["FS_SAFE_OWNER_DACL_BATCH_MODE"]);
  });

  it("keeps a native query failure terminal instead of starting a fallback process", async () => {
    __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn(), readOwnerAndDacl: vi.fn() }) as unknown as NativeBinding);
    configureFsSafeNative({ mode: "auto" });
    const child = commandChild();
    const pending = readOwnerAndDaclBatch([firstPath]);
    child.finish({ ok: false, code: "EACCES", message: "native descriptor access denied" });
    await expect(pending).rejects.toMatchObject({ code: "EACCES", message: "native descriptor access denied" });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("captures selected-drive paths before dispatch without erasing their suffix", async () => {
    const resolve = path.resolve;
    let driveDirectory = String.raw`C:\selected`;
    vi.spyOn(path, "resolve").mockImplementation((...segments) =>
      segments.length === 1 && segments[0] === "C:" ? driveDirectory : resolve(...segments));
    const child = commandChild();
    const pending = readOwnerAndDaclBatch([String.raw`C:link\..\entry`, "C:"]);
    const expected = [`${driveDirectory}${path.sep}link\\..\\entry`, `${driveDirectory}${path.sep}`];
    driveDirectory = String.raw`C:\replacement`;
    expect(child.input()).toEqual(expected);
    child.finish({ ok: true, result: expected.map(path => ({ path, security: security() })) });
    expect(await pending).toHaveLength(2);
  });

  it("rejects required native unavailability before starting a process", async () => {
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn() }) as unknown as NativeBinding);
    await expect(readOwnerAndDaclBatch([firstPath])).rejects.toMatchObject({ code: "helper-unavailable" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves raw null, remote and incomplete DACL facts without classifying their trust", async () => {
    const child = commandChild();
    const pending = readOwnerAndDaclBatch([firstPath, secondPath]);
    child.finish({ ok: true, result: [
      { path: firstPath, security: { ...security(), daclPresent: false, aces: [] } },
      { path: secondPath, security: { ...security(), isLocal: false, aceListComplete: false, unsupportedAceTypes: [5] } },
    ] });
    expect(await pending).toMatchObject([
      { status: "supported", daclPresent: false, aces: [] },
      { status: "supported", isLocal: false, complete: false, unsupportedAceTypes: [5] },
    ]);
  });

  it.each(["missing", "reordered", "invalid-facts"])("returns no partial batch for %s rows", async failure => {
    const child = commandChild();
    const rows = [
      { path: firstPath, security: security() },
      { path: secondPath, security: security() },
    ];
    if (failure === "missing") rows.pop();
    else if (failure === "reordered") rows.reverse();
    else rows[1]!.security.aces[0]!.mask = -1;
    const pending = readOwnerAndDaclBatch([firstPath, secondPath]);
    child.finish({ ok: true, result: rows });
    await expect(pending).rejects.toMatchObject({ code: "permission-unverified" });
  });

  it("waits for process and pipe closure before releasing successful facts", async () => {
    const { child, finish } = commandChild();
    let returned = false;
    const pending = readOwnerAndDaclBatch([firstPath]).then(result => { returned = true; return result; });
    child.emit("exit", 0, null);
    await Promise.resolve();
    expect(returned).toBe(false);
    finish({ ok: true, result: [{ path: firstPath, security: security() }] });
    expect(await pending).toHaveLength(1);
  });

  it("uses one 60-second budget and reports unconfirmed termination after grace", async () => {
    vi.useFakeTimers();
    const { child } = commandChild();
    const rejected = readOwnerAndDaclBatch([firstPath, secondPath]).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await rejected).toMatchObject({
      timedOut: true, processExitConfirmed: false,
      message: "Windows permission inspection timed out after 60000ms; process exit was not confirmed",
      cause: { processExitConfirmed: false, outputClosed: false, terminationSignalSent: false },
    });
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("joins timeout cleanup when exit and closed pipes are confirmed during grace", async () => {
    vi.useFakeTimers();
    const { child } = commandChild();
    const rejected = readOwnerAndDaclBatch([firstPath], { timeoutMs: 50 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    expect(await rejected).toMatchObject({
      timedOut: true, processExitConfirmed: true,
      cause: { processExitConfirmed: true, outputClosed: true },
    });
    expect(child.unref).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts stdout and stderr together under the 16 MiB batch limit", async () => {
    vi.useFakeTimers();
    const { child } = commandChild();
    const rejected = readOwnerAndDaclBatch([firstPath]).catch((error: unknown) => error);
    child.stdout.emit("data", Buffer.alloc(1024 * 1024));
    expect(child.kill).not.toHaveBeenCalled();
    child.stderr.emit("data", Buffer.alloc(15 * 1024 * 1024 + 1));
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("close", null, "SIGKILL");
    expect(await rejected).toMatchObject({ timedOut: false, cause: {
      cause: { message: "Windows security command exceeded its output budget" },
    } });
  });

  it.each([0, -1, NaN, Infinity, 2_147_483_648])("rejects invalid timeout %s before dispatch", async timeoutMs => {
    await expect(readOwnerAndDaclBatch([firstPath], { timeoutMs })).rejects.toBeInstanceOf(RangeError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["", "C:\\bad\0path", "C:\\file:stream"])("rejects an invalid member %j before any query", async invalid => {
    await expect(readOwnerAndDaclBatch([firstPath, invalid])).rejects.toBeInstanceOf(Error);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("handles empty batches and unsupported platforms without process creation", async () => {
    expect(await readOwnerAndDaclBatch([])).toEqual([]);
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    expect(await readOwnerAndDaclBatch(["/tmp/one", "/tmp/two"])).toEqual([
      { status: "unsupported-platform", platform: "linux" },
      { status: "unsupported-platform", platform: "linux" },
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });
});
