import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { readSecureFile } from "../src/secure-file.js";
import * as command from "../src/windows-security-command.js";
import { useTempDirs } from "./helpers/vitest.js";
import { runWindowsSecurityScript, WINDOWS_SECURITY_SOURCE } from "./helpers/windows-security-script.js";

const { tempRoot } = useTempDirs();
const localityFailure = { ok: false, code: "EIO", message: "injected locality query failure" };

function faultedBridge(operation: "path" | "descriptor" | "create", failAt: number, targetPath = "", fd?: number) {
  const replaceOnce = (source: string, needle: string, replacement: string) => {
    expect(source.split(needle)).toHaveLength(2);
    return source.replace(needle, replacement);
  };
  let source = replaceOnce(WINDOWS_SECURITY_SOURCE,
    "public static partial class FsSafeWindowsBridge {",
    "public static partial class FsSafeWindowsBridge { public static int LocalityCalls, CreateCalls; public static string ObservedIdentity;");
  source = replaceOnce(source,
    "  static bool IsLocal(SafeFileHandle handle) {",
    "  static bool IsLocal(SafeFileHandle handle) { LocalityCalls++; if(LocalityCalls==Int32.Parse(Environment.GetEnvironmentVariable(\"FS_SAFE_TEST_LOCALITY_FAIL_AT\"))) throw new Failure(\"EIO\",\"injected locality query failure\"); return IsLocalOriginal(handle); }\n" +
    "  static bool IsLocalOriginal(SafeFileHandle handle) {");
  source = replaceOnce(source,
    "  static SafeFileHandle CreateRelative(SafeFileHandle parent,string name) {",
    "  static SafeFileHandle CreateRelative(SafeFileHandle parent,string name) { CreateCalls++;");
  source = replaceOnce(source, "    return info.Volume.ToString(\"x8\")", "    return ObservedIdentity=info.Volume.ToString(\"x8\")");
  const stdout = runWindowsSecurityScript(source, [
    "$reply=[FsSafeWindowsBridge]::Execute([Environment]::GetEnvironmentVariable('FS_SAFE_TEST_SECURITY_OPERATION'),[Environment]::GetEnvironmentVariable('FS_SAFE_TEST_SECURITY_PATH'))",
    "@{reply=$reply;localityCalls=[FsSafeWindowsBridge]::LocalityCalls;createCalls=[FsSafeWindowsBridge]::CreateCalls;identity=[FsSafeWindowsBridge]::ObservedIdentity}|ConvertTo-Json -Depth 8 -Compress",
  ], {
    FS_SAFE_TEST_SECURITY_OPERATION: operation,
    FS_SAFE_TEST_SECURITY_PATH: targetPath, FS_SAFE_TEST_LOCALITY_FAIL_AT: String(failAt),
  }, fd);
  return JSON.parse(stdout.trim());
}

describe.runIf(process.platform === "win32")("Windows locality-query failure parity", () => {
  beforeEach(() => {
    configureFsSafeNative({ mode: "off" });
    __setNativeLoaderForTest(() => { throw new Error("optional addon deliberately unavailable"); });
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetFsSafeNativeConfigForTest();
    __resetNativeLoaderForTest();
  });

  it("returns raw owner and DACL facts with unknown locality", async () => {
    const directory = await tempRoot("fs-safe-win-raw-locality-");
    const filePath = path.join(directory, "facts-雪-é-🦀");
    await fs.writeFile(filePath, "unchanged payload");
    const expected = command.readWindowsSecurityFactsCommand(filePath);
    const result = faultedBridge("path", 1, filePath);
    expect(result).toMatchObject({ localityCalls: 1, createCalls: 0, reply: { ok: true, result: {
      ownerSid: expected.ownerSid, currentUserSid: expected.currentUserSid, isLocal: false,
      daclPresent: expected.daclPresent, aceListComplete: expected.aceListComplete,
      unsupportedAceTypes: expected.unsupportedAceTypes, aces: expected.aces,
    } } });
    expect(await fs.readFile(filePath, "utf8")).toBe("unchanged payload");
  }, 65_000);

  it("rejects a failed query on the borrowed descriptor before reading file contents", async () => {
    const directory = await tempRoot("fs-safe-win-descriptor-locality-");
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "unread secret");
    const open = fs.open.bind(fs);
    let read: ReturnType<typeof vi.spyOn> | undefined;
    let readFile: ReturnType<typeof vi.spyOn> | undefined;
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      read = vi.spyOn(handle, "read");
      readFile = vi.spyOn(handle, "readFile");
      close = vi.spyOn(handle, "close");
      return handle;
    });
    const inspect = vi.spyOn(command, "inspectWindowsDescriptorCommand").mockImplementationOnce(async fd => {
      const before = fsSync.fstatSync(fd, { bigint: true });
      const result = faultedBridge("descriptor", 1, "", fd);
      expect(result).toEqual({ reply: localityFailure, localityCalls: 1, createCalls: 0,
        identity: `${before.dev.toString(16).padStart(8, "0")}:${before.ino.toString(16).padStart(16, "0")}` });
      throw Object.assign(new Error(result.reply.message), { code: result.reply.code });
    });
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({
      code: "permission-unverified", cause: { code: "EIO", message: localityFailure.message },
    });
    expect(inspect).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(await fs.readFile(filePath, "utf8")).toBe("unread secret");
  }, 35_000);

  it.each([
    { label: "parent admission", failAt: 1, created: 0 },
    { label: "created child security", failAt: 2, created: 1 },
  ])("rejects ambiguous locality during $label and preserves the parent", async ({ failAt, created }) => {
    const directory = await tempRoot("fs-safe-win-private-locality-error-");
    const filePath = path.join(directory, "keep");
    const targetPath = path.join(directory, "private");
    await fs.writeFile(filePath, "parent sentinel");
    const before = await fs.stat(directory, { bigint: true });
    const result = faultedBridge("create", failAt, targetPath);
    expect(result).toMatchObject({ reply: localityFailure, localityCalls: failAt, createCalls: created });
    await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(directory)).toEqual(["keep"]);
    expect(await fs.readFile(filePath, "utf8")).toBe("parent sentinel");
    const after = await fs.stat(directory, { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  }, 35_000);
});
