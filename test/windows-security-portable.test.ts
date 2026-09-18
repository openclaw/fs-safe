import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { createPrivateDirectory } from "../src/private-directory.js";
import { readOwnerAndDacl } from "../src/owner-dacl.js";
import { readSecureFile } from "../src/secure-file.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import * as command from "../src/windows-security-command.js";
import { useTempDirs } from "./helpers/vitest.js";
import { runWindowsSecurityScript, WINDOWS_SECURITY_SOURCE } from "./helpers/windows-security-script.js";

const { tempRoot } = useTempDirs();
const inspectDescriptor = command.inspectWindowsDescriptorCommand;

function icacls(target: string, ...args: string[]): void {
  execFileSync(resolveWindowsSystemCommand("icacls.exe"), [target, ...args], {
    windowsHide: true, stdio: "pipe", timeout: 30_000,
  });
}

async function privateFile(name = "secret"): Promise<string> {
  const root = await tempRoot("fs-safe-portable-win-");
  const directory = path.join(root, "private-é-🦀");
  await createPrivateDirectory(directory);
  const file = path.join(directory, name);
  await fs.writeFile(file, "pinned secret");
  return file;
}

function watchNextFileReads() {
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
  return { read: () => read, readFile: () => readFile, close: () => close };
}

describe.runIf(process.platform === "win32")("Windows built-in security commands without addons", () => {
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

  it.each([
    { ntstatus: "c000007f", code: "ENOSPC" },
    { ntstatus: "c0000043", code: "EBUSY" },
  ])("preserves $code from the private-directory creation syscall", async ({ ntstatus, code }) => {
    const directory = await tempRoot("fs-safe-win-create-error-");
    const target = path.join(directory, "private");
    const syscall = "IoStatus io; SafeFileHandle created;\n" +
      "      int status=NtCreateFile(out created,0x00130180,ref attributes,out io,IntPtr.Zero,0,7,2,0x00200021,IntPtr.Zero,0);";
    expect(WINDOWS_SECURITY_SOURCE.split(syscall)).toHaveLength(2);
    const source = WINDOWS_SECURITY_SOURCE.replace(syscall,
      `SafeFileHandle created=null; int status=unchecked((int)0x${ntstatus});`);
    const stdout = runWindowsSecurityScript(source, [
      "[FsSafeWindowsBridge]::Execute('create',[Environment]::GetEnvironmentVariable('FS_SAFE_TEST_TARGET'))|ConvertTo-Json -Depth 8 -Compress",
    ], { FS_SAFE_TEST_TARGET: target });
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, code });
    expect(await fs.readdir(directory)).toEqual([]);
  }, 35_000);

  it.each([
    { label: "initial parent", failAt: 1, expectedCreates: 0, expectedIdentityQueries: 0 },
    { label: "reopened named parent", failAt: 3, expectedCreates: 1, expectedIdentityQueries: 3 },
    { label: "final named child", failAt: 4, expectedCreates: 1, expectedIdentityQueries: 4 },
  ])("rejects nonlocal $label before its identity query and preserves the parent", async ({
    failAt, expectedCreates, expectedIdentityQueries,
  }) => {
    const directory = await tempRoot("fs-safe-win-parent-locality-");
    const target = path.join(directory, "private");
    const sentinel = path.join(directory, "keep");
    await fs.writeFile(sentinel, "parent sentinel");
    const before = await fs.stat(directory, { bigint: true });
    const replaceOnce = (source: string, needle: string, replacement: string) => {
      expect(source.split(needle)).toHaveLength(2);
      return source.replace(needle, replacement);
    };
    // Substitute the OS locality observation in this child-only source copy.
    // Counters distinguish rejection before creation from create-then-cleanup.
    let source = replaceOnce(WINDOWS_SECURITY_SOURCE,
      "public static partial class FsSafeWindowsBridge {",
      "public static partial class FsSafeWindowsBridge { public static int LocalityCalls, CreateCalls, IdentityQueries;");
    source = replaceOnce(source,
      "  static bool IsLocal(SafeFileHandle handle) {",
      "  static bool IsLocal(SafeFileHandle handle) { LocalityCalls++; return LocalityCalls!=Int32.Parse(Environment.GetEnvironmentVariable(\"FS_SAFE_LOCALITY_FAIL_AT\")); }\n" +
      "  static bool IsLocalOriginal(SafeFileHandle handle) {");
    source = replaceOnce(source,
      "  static SafeFileHandle CreateRelative(SafeFileHandle parent,string name) {",
      "  static SafeFileHandle CreateRelative(SafeFileHandle parent,string name) { CreateCalls++;");
    source = replaceOnce(source, "    FileId id;", "    IdentityQueries++; FileId id;");
    const stdout = runWindowsSecurityScript(source, [
      "$reply=[FsSafeWindowsBridge]::Execute('create',[Environment]::GetEnvironmentVariable('FS_SAFE_LOCALITY_TARGET'))",
      "@{reply=$reply;localityCalls=[FsSafeWindowsBridge]::LocalityCalls;createCalls=[FsSafeWindowsBridge]::CreateCalls;identityQueries=[FsSafeWindowsBridge]::IdentityQueries}|ConvertTo-Json -Depth 8 -Compress",
    ], { FS_SAFE_LOCALITY_FAIL_AT: String(failAt), FS_SAFE_LOCALITY_TARGET: target });
    expect(JSON.parse(stdout.trim())).toEqual({
      reply: { ok: false, code: "ENOTSUP", message: "private directories require a local filesystem" },
      localityCalls: failAt, createCalls: expectedCreates, identityQueries: expectedIdentityQueries,
    });
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(directory)).toEqual(["keep"]);
    expect(await fs.readFile(sentinel, "utf8")).toBe("parent sentinel");
    const after = await fs.stat(directory, { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  }, 35_000);

  it.each([
    ["GetFileInformationByHandle", "EPERM"],
    ["GetFileInformationByHandleEx", "EPERM"],
    ["GetSecurityInfo", "EACCES"],
  ] as const)("preserves native access-denied classification from %s", async (method, code) => {
    const directory = await tempRoot("fs-safe-win-security-error-");
    const target = path.join(directory, "private");
    const sentinel = path.join(directory, "keep");
    await fs.writeFile(sentinel, "parent sentinel");
    const before = await fs.stat(directory, { bigint: true });
    const declaration = WINDOWS_SECURITY_SOURCE.split("\n").find(line =>
      line.includes("static extern ") && line.includes(` ${method}(`));
    expect(declaration).toBeDefined();
    const replacements = {
      GetFileInformationByHandle: "static bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfo information) { information=new FileInfo(); SetTestLastError(5); return false; }",
      GetFileInformationByHandleEx: "static bool GetFileInformationByHandleEx(SafeFileHandle handle,int kind,out FileId information,uint size) { information=new FileId(); SetTestLastError(5); return false; }",
      GetSecurityInfo: "static uint GetSecurityInfo(SafeFileHandle handle,int kind,uint sections,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor) { owner=group=dacl=sacl=descriptor=IntPtr.Zero; return 5; }",
    };
    const source = WINDOWS_SECURITY_SOURCE.replace(declaration!,
      "  [DllImport(\"kernel32.dll\",EntryPoint=\"SetLastError\",SetLastError=true)] static extern void SetTestLastError(uint error);\n  " + replacements[method]);
    const stdout = runWindowsSecurityScript(source, [
      "[FsSafeWindowsBridge]::Execute('create',[Environment]::GetEnvironmentVariable('FS_SAFE_SECURITY_ERROR_TARGET'))|ConvertTo-Json -Depth 8 -Compress",
    ], { FS_SAFE_SECURITY_ERROR_TARGET: target });
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: false, code });
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(directory)).toEqual(["keep"]);
    expect(await fs.readFile(sentinel, "utf8")).toBe("parent sentinel");
    const after = await fs.stat(directory, { bigint: true });
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
  }, 35_000);

  it("matches the native locality spelling rules for volume, DOS, and UNC paths", () => {
    const cases = [
      ["IsVolumeGuidPath", String.raw`\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\file`, true],
      ["IsVolumeGuidPath", String.raw`\\?\vOlUmE{01234567-89AB-CDEF-0123-456789ABCDEF}\file`, true],
      ["IsVolumeGuidPath", String.raw`\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}`, false],
      ["IsVolumeGuidPath", String.raw`\\?\Volume{01234567-89ab-cdef-0123-456789abcdeg}\file`, false],
      ["IsVolumeGuidPath", String.raw`\\?\C:\file`, false],
      ["IsLocalFinalPath", String.raw`C:\file`, true],
      ["IsLocalFinalPath", String.raw`\\?\C:\file`, true],
      ["IsLocalFinalPath", String.raw`\\?\Volume{01234567-89ab-cdef-0123-456789abcdef}\file`, true],
      ["IsLocalFinalPath", String.raw`\\server\share\file`, false],
      ["IsLocalFinalPath", String.raw`\\?\UNC\server\share\file`, false],
    ] as const;
    const stdout = runWindowsSecurityScript(WINDOWS_SECURITY_SOURCE, [
      "$flags=[Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static",
      "$cases=ConvertFrom-Json ([Environment]::GetEnvironmentVariable('FS_SAFE_WINDOWS_LOCALITY_CASES'))",
      "@($cases|ForEach-Object{[FsSafeWindowsBridge].GetMethod($_[0],$flags).Invoke($null,@($_[1]))})|ConvertTo-Json -Compress",
    ], { FS_SAFE_WINDOWS_LOCALITY_CASES: JSON.stringify(cases) });
    expect(JSON.parse(stdout.trim())).toEqual(cases.map(([, , expected]) => expected));
  }, 35_000);

  it.each(["exact Unicode imports", "original Unicode imports"] as const)(
    "round-trips an actual Unicode handle path after the locality query is unavailable with %s", async imports => {
      const directory = await tempRoot("fs-safe-win-locality-marshal-");
      const filePath = path.join(directory, "local-雪-é-🦀.txt");
      await fs.writeFile(filePath, "unchanged payload");
      const canonical = fsSync.realpathSync.native(filePath);
      const expectedPath = canonical.startsWith("\\\\?\\") ? canonical : "\\\\?\\" + canonical;
      expect(WINDOWS_SECURITY_SOURCE.split(", ExactSpelling=true")).toHaveLength(3);
      let source = imports === "original Unicode imports"
        ? WINDOWS_SECURITY_SOURCE.replaceAll(", ExactSpelling=true", "") : WINDOWS_SECURITY_SOURCE;
      const declaration = source.split("\n").find(line => line.includes("static extern int NtQueryInformationFile("));
      expect(declaration).toBeDefined();
      source = source.replace(declaration!,
        "  public static int ForcedLocalityQueries;\n" +
        "  static int NtQueryInformationFile(SafeFileHandle handle,out IoStatus io,byte[] information,uint length,int kind) { ForcedLocalityQueries++; io=new IoStatus(); return unchecked((int)0xc0000003); }");
      const stdout = runWindowsSecurityScript(source, [
        "$flags=[Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static",
        "$type=[FsSafeWindowsBridge]",
        "$p=[Environment]::GetEnvironmentVariable('FS_SAFE_WINDOWS_LOCALITY_TARGET')",
        "$handle=$type.GetMethod('Open',$flags).Invoke($null,@($p,[uint32]0x80,$true))",
        "try{$final=$type.GetMethod('FinalPath',$flags).Invoke($null,@($handle,[uint32]0));$local=$type.GetMethod('IsLocal',$flags).Invoke($null,@($handle));@{finalPath=$final;isLocal=$local;forcedLocalityQueries=[FsSafeWindowsBridge]::ForcedLocalityQueries}|ConvertTo-Json -Compress}finally{$handle.Dispose()}",
      ], { FS_SAFE_WINDOWS_LOCALITY_TARGET: filePath });
      const result = JSON.parse(stdout.trim());
      expect(result.finalPath).toBe(expectedPath);
      expect(result.isLocal).toBe(true);
      expect(result.forcedLocalityQueries).toBeGreaterThan(0);
      expect(await fs.readFile(filePath, "utf8")).toBe("unchanged payload");
    }, 35_000,
  );

  it.each(["off", "auto"] as const)("creates private directories, exposes raw ACLs, and reads credentials in %s", async mode => {
    configureFsSafeNative({ mode });
    const filePath = await privateFile();
    const facts = readOwnerAndDacl(path.dirname(filePath));
    expect(facts).toMatchObject({ status: "supported", isLocal: true, daclPresent: true, complete: true, unsupportedAceTypes: [] });
    if (facts.status !== "supported") throw new Error("Windows facts are missing");
    expect(facts.ownerSid).toBe(facts.currentUserSid);
    expect(facts.aces).toHaveLength(3);
    expect(facts.aces.map(ace => ace.sid).sort()).toEqual([facts.currentUserSid, "s-1-5-18", "s-1-5-32-544"].sort());
    expect(facts.aces.every(ace => ace.mask === 0x1f01ff && ace.flags.objectInherit && ace.flags.containerInherit && !ace.flags.inherited)).toBe(true);
    const read = await readSecureFile({ filePath });
    expect(read.buffer.toString()).toBe("pinned secret");
    expect(read.permissions).toMatchObject({ source: "windows-acl", ownerTrusted: true, worldReadable: false, groupReadable: false });
  }, 95_000);

  it("rejects a missing package in require mode without starting system commands", async () => {
    const filePath = await privateFile();
    vi.mocked(process.emitWarning).mockClear();
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => { throw new Error("optional addon deliberately unavailable"); });
    const inspect = vi.spyOn(command, "inspectWindowsDescriptorCommand");
    const read = vi.spyOn(command, "readWindowsSecurityFactsCommand");
    const create = vi.spyOn(command, "createPrivateWindowsDirectoryCommand");
    const target = path.join(path.dirname(filePath), "require-native");
    expect(() => readOwnerAndDacl(filePath)).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
    await expect(createPrivateDirectory(target)).rejects.toMatchObject({ code: "helper-unavailable" });
    const watched = watchNextFileReads();
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "permission-unverified" });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(inspect).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(watched.read()).not.toHaveBeenCalled();
    expect(watched.readFile()).not.toHaveBeenCalled();
    expect(watched.close()).toHaveBeenCalledOnce();
    expect(process.emitWarning).not.toHaveBeenCalled();
  }, 35_000);

  it("rejects missing native capabilities in require mode before commands or content reads", async () => {
    const filePath = await privateFile();
    vi.mocked(process.emitWarning).mockClear();
    configureFsSafeNative({ mode: "require" });
    __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn() }) as unknown as NativeBinding);
    const inspect = vi.spyOn(command, "inspectWindowsDescriptorCommand");
    const read = vi.spyOn(command, "readWindowsSecurityFactsCommand");
    const create = vi.spyOn(command, "createPrivateWindowsDirectoryCommand");
    const target = path.join(path.dirname(filePath), "require-capabilities");
    expect(() => readOwnerAndDacl(filePath)).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
    await expect(createPrivateDirectory(target)).rejects.toMatchObject({ code: "helper-unavailable" });
    const watched = watchNextFileReads();
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "permission-unverified" });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(inspect).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(watched.read()).not.toHaveBeenCalled();
    expect(watched.readFile()).not.toHaveBeenCalled();
    expect(watched.close()).toHaveBeenCalledOnce();
    expect(process.emitWarning).not.toHaveBeenCalled();
  }, 35_000);

  it("allows missing-capability fallbacks in auto mode after a successful addon load", async () => {
    configureFsSafeNative({ mode: "auto" });
    __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn() }) as unknown as NativeBinding);
    const inspect = vi.spyOn(command, "inspectWindowsDescriptorCommand");
    const read = vi.spyOn(command, "readWindowsSecurityFactsCommand");
    const create = vi.spyOn(command, "createPrivateWindowsDirectoryCommand");
    const filePath = await privateFile();
    expect(readOwnerAndDacl(filePath)).toMatchObject({ status: "supported", complete: true });
    expect((await readSecureFile({ filePath })).buffer.toString()).toBe("pinned secret");
    expect(inspect).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  }, 95_000);

  it("uses the descriptor fallback when an otherwise loadable addon lacks its capability", async () => {
    const filePath = await privateFile();
    configureFsSafeNative({ mode: "auto" });
    const pathname = vi.fn(() => { throw new Error("legacy pathname inspection must not run"); });
    __setNativeLoaderForTest(() => ({ closeOwnedFd: vi.fn(), readOwnerAndDacl: pathname }) as unknown as NativeBinding);
    expect((await readSecureFile({ filePath })).buffer.toString()).toBe("pinned secret");
    expect(pathname).not.toHaveBeenCalled();
  }, 65_000);

  it("retains the caller's handle and file position through the child process", async () => {
    const file = await privateFile();
    const handle = await fs.open(file, "r");
    try {
      const prefix = Buffer.alloc(7);
      await handle.read(prefix, 0, prefix.length, null);
      expect(prefix.toString()).toBe("pinned ");
      const before = fsSync.fstatSync(handle.fd, { bigint: true });
      const result = await inspectDescriptor(handle.fd);
      expect(result.identity).toBe(`${before.dev.toString(16).padStart(8, "0")}:${before.ino.toString(16).padStart(16, "0")}`);
      expect((await handle.readFile()).toString()).toBe("secret");
      expect(fsSync.fstatSync(handle.fd, { bigint: true }).ino).toBe(before.ino);
    } finally { await handle.close(); }
  }, 65_000);

  it("supports extended-length local path spelling without .NET pathname normalization", async () => {
    const filePath = await privateFile();
    const extendedDirectory = `\\\\?\\${path.join(path.dirname(filePath), "extended")}`;
    await createPrivateDirectory(extendedDirectory);
    const extended = `\\\\?\\${filePath}`;
    expect(readOwnerAndDacl(extended)).toMatchObject({ status: "supported", isLocal: true });
    expect((await readSecureFile({ filePath: extended })).buffer.toString()).toBe("pinned secret");
  }, 125_000);

  it("rejects an insecure pinned file after its pathname is replaced with a private file", async () => {
    const filePath = await privateFile();
    const replacement = path.join(path.dirname(filePath), "replacement");
    const original = path.join(path.dirname(filePath), "original");
    await fs.writeFile(replacement, "private replacement");
    icacls(filePath, "/grant", "*S-1-1-0:R");
    vi.spyOn(command, "inspectWindowsDescriptorCommand").mockImplementationOnce(async fd => {
      fsSync.renameSync(filePath, original);
      fsSync.renameSync(replacement, filePath);
      return await inspectDescriptor(fd);
    });
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "insecure-permissions" });
    expect(await fs.readFile(filePath, "utf8")).toBe("private replacement");
    expect(await fs.readFile(original, "utf8")).toBe("pinned secret");
  }, 65_000);

  it("protects creation from broad inherited parent grants", async () => {
    const root = await tempRoot("fs-safe-portable-win-inherit-");
    icacls(root, "/grant", "*S-1-1-0:(OI)(CI)F");
    const directory = path.join(root, "private");
    await createPrivateDirectory(directory);
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "private despite parent");
    expect((await readSecureFile({ filePath })).buffer.toString()).toBe("private despite parent");
  }, 65_000);

  it("preserves existing empty and populated directories", async () => {
    const root = await tempRoot("fs-safe-portable-win-collision-");
    for (const populated of [false, true]) {
      const directory = path.join(root, populated ? "populated" : "empty");
      await fs.mkdir(directory);
      if (populated) await fs.writeFile(path.join(directory, "keep"), "existing");
      const before = await fs.stat(directory, { bigint: true });
      await expect(createPrivateDirectory(directory)).rejects.toMatchObject({ code: "EEXIST" });
      const after = await fs.stat(directory, { bigint: true });
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(await fs.readdir(directory)).toEqual(populated ? ["keep"] : []);
    }
  }, 65_000);

  it("rejects an immediate parent junction without creating its child", async () => {
    const root = await tempRoot("fs-safe-portable-win-junction-");
    const target = path.join(root, "target"), junction = path.join(root, "junction");
    await fs.mkdir(target);
    await fs.symlink(target, junction, "junction");
    await expect(createPrivateDirectory(path.join(junction, "private"))).rejects.toMatchObject({ code: "ELOOP" });
    expect(await fs.readdir(target)).toEqual([]);
  }, 35_000);

  it("rejects an invalid borrowed descriptor rather than inspecting a pathname", async () => {
    await expect(inspectDescriptor(-1)).rejects.toMatchObject({ code: "permission-unverified" });
  });
});
