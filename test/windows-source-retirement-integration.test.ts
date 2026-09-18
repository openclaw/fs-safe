import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { publishFileExclusive } from "../src/publish-file.js";
import * as retirement from "../src/windows-source-retirement.js";
import { WINDOWS_SOURCE_RETIREMENT_SOURCE } from "../src/windows-source-retirement-source.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const retire = retirement.retireWindowsSourceNameSync;
function identity(file: string) {
  const stat = fsSync.statSync(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}
function encodedIdentity(value: { dev: bigint; ino: bigint }): string {
  return value.dev.toString(16).padStart(8, "0") + ":" + value.ino.toString(16).padStart(16, "0");
}
async function fixture(extraLinks = 0) {
  const directory = await tempRoot("fs-safe-win-retire-");
  const source = path.join(directory, "source-é"), target = path.join(directory, "target");
  await fs.writeFile(source, "payload A"); await fs.link(source, target);
  for (let index = 0; index < extraLinks; index++) await fs.link(source, path.join(directory, `extra-${index}`));
  return { directory, source, target, args: { sourcePath: source, sourceParentPath: directory,
    sourceParentIdentity: identity(directory), identity: identity(source), expectedLinks: BigInt(2 + extraLinks) } };
}
function rewrite(source: string, needle: string, replacement: string): string {
  expect(source.split(needle)).toHaveLength(2);
  return source.replace(needle, replacement);
}
function runSource(source: string, f: Awaited<ReturnType<typeof fixture>>) {
  const request = [f.directory, encodedIdentity(f.args.sourceParentIdentity), path.basename(f.source), encodedIdentity(f.args.identity), Number(f.args.expectedLinks)];
  const query = [
    "$ErrorActionPreference='Stop'", "Add-Type -TypeDefinition ([Console]::In.ReadToEnd())",
    "$p=ConvertFrom-Json ([Environment]::GetEnvironmentVariable('FS_SAFE_RETIRE_TEST_REQUEST'))",
    "[FsSafeWindowsBridge]::ExecuteRetirement($p[0],$p[1],$p[2],$p[3],$p[4])|ConvertTo-Json -Depth 8 -Compress",
  ].join(";");
  return JSON.parse(execFileSync(resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query,
  ], { input: source, encoding: "utf8", windowsHide: true, timeout: 30_000,
    env: { ...process.env, FS_SAFE_RETIRE_TEST_REQUEST: JSON.stringify(request), FS_SAFE_RETIRE_TEST_SOURCE: f.source } }).trim());
}
function parentAccess(directory: string, restricted: boolean): void {
  const query = [
    "$ErrorActionPreference='Stop'", "$p=[Environment]::GetEnvironmentVariable('FS_SAFE_RETIRE_PARENT')",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$a=[Security.AccessControl.DirectorySecurity]::new();$a.SetAccessRuleProtection($true,$false)",
    ...(restricted ? ["$a.SetOwner($sid)"] : []),
    ...(restricted ? ["$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]5,[Security.AccessControl.AccessControlType]::Deny))"] : []),
    `$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]${restricted ? 0x001200e2 : 0x001f01ff},[Security.AccessControl.AccessControlType]::Allow))`,
    "[IO.Directory]::SetAccessControl($p,$a)",
  ].join(";");
  execFileSync(resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query], {
    windowsHide: true, stdio: "pipe", timeout: 30_000, env: { ...process.env, FS_SAFE_RETIRE_PARENT: directory },
  });
}

describe.runIf(process.platform === "win32")("Windows exact-source-handle retirement", () => {
  beforeEach(() => {
    configureFsSafeNative({ mode: "off" });
    __setNativeLoaderForTest(() => { throw new Error("native addon deliberately unavailable"); });
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

  it.each([
    { pin: "source", readOnly: false, extra: 0 }, { pin: "target", readOnly: false, extra: 0 },
    { pin: "source", readOnly: true, extra: 0 }, { pin: "target", readOnly: true, extra: 0 },
    { pin: "target", readOnly: false, extra: 2 },
  ] as const)("retires source with $pin pin, readonly=$readOnly and extra links=$extra", async ({ pin, readOnly, extra }) => {
    const f = await fixture(extra);
    if (readOnly) await fs.chmod(f.source, 0o400);
    const before = await fs.stat(f.source, { bigint: true });
    const fd = fsSync.openSync(f[pin], "r");
    try {
      const prefix = Buffer.alloc(3); fsSync.readSync(fd, prefix, 0, 3, null);
      expect(prefix.toString()).toBe("pay");
      retire(f.args);
      await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.stat(f.target, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, nlink: BigInt(1 + extra), mode: before.mode });
      expect(fsSync.fstatSync(fd, { bigint: true }).nlink).toBe(BigInt(1 + extra));
      expect(fsSync.readFileSync(fd, "utf8")).toBe("load A");
      expect(await fs.readFile(f.target, "utf8")).toBe("payload A");
    } finally { fsSync.closeSync(fd); }
  }, 35_000);

  it("does not require source-directory listing or subdirectory creation", async () => {
    const f = await fixture(); const pin = fsSync.openSync(f.target, "r");
    try {
      parentAccess(f.directory, true);
      await expect(fs.readdir(f.directory)).rejects.toMatchObject({ code: expect.stringMatching(/^(EACCES|EPERM)$/) });
      await expect(fs.mkdir(path.join(f.directory, "forbidden-directory"))).rejects.toMatchObject({ code: expect.stringMatching(/^(EACCES|EPERM)$/) });
      retire(f.args);
      expect(fsSync.fstatSync(pin, { bigint: true }).nlink).toBe(1n);
      expect(await fs.readFile(f.target, "utf8")).toBe("payload A");
    } finally { parentAccess(f.directory, false); fsSync.closeSync(pin); }
  }, 95_000);

  it.each(["before-open", "after-open"] as const)("preserves B and target A when source substitution occurs %s", async timing => {
    const f = await fixture(); const pin = fsSync.openSync(f.target, "r");
    const retired = f.source + "-retired-A";
    const substitute = "string path=Environment.GetEnvironmentVariable(\"FS_SAFE_RETIRE_TEST_SOURCE\"); System.IO.File.Move(path,path+\"-retired-A\"); System.IO.File.WriteAllText(path,\"replacement B\");";
    let source = WINDOWS_SOURCE_RETIREMENT_SOURCE;
    if (timing === "before-open") {
      source = rewrite(source, "  static SafeFileHandle OpenRetirementSource(SafeFileHandle parent,string name) {",
        "  static SafeFileHandle OpenRetirementSource(SafeFileHandle parent,string name) { " + substitute + " return OpenRetirementSourceOriginal(parent,name); }\n" +
        "  static SafeFileHandle OpenRetirementSourceOriginal(SafeFileHandle parent,string name) {");
    } else {
      source = rewrite(source, "  static bool SetSourceDisposition(SafeFileHandle source,ref uint flags) {",
        "  static bool SetSourceDisposition(SafeFileHandle source,ref uint flags) { " + substitute + " return SetSourceDispositionOriginal(source,ref flags); }\n" +
        "  static bool SetSourceDispositionOriginal(SafeFileHandle source,ref uint flags) {");
    }
    try {
      const result = runSource(source, f);
      expect(await fs.readFile(f.source, "utf8")).toBe("replacement B");
      expect(await fs.readFile(f.target, "utf8")).toBe("payload A");
      if (timing === "before-open") {
        expect(result).toMatchObject({ ok: false, phase: "admission", commit: "not-attempted", code: "path-mismatch" });
        expect(await fs.readFile(retired, "utf8")).toBe("payload A");
        expect(fsSync.fstatSync(pin, { bigint: true }).nlink).toBe(2n);
      } else {
        expect(result).toMatchObject({ ok: true, phase: "complete", commit: "committed", remainingLinks: 1 });
        await expect(fs.lstat(retired)).rejects.toMatchObject({ code: "ENOENT" });
        expect(fsSync.fstatSync(pin, { bigint: true }).nlink).toBe(1n);
      }
    } finally { fsSync.closeSync(pin); }
  }, 35_000);

  it("preserves both names when extended disposition is unavailable", async () => {
    const f = await fixture(); const pin = fsSync.openSync(f.source, "r");
    const source = rewrite(WINDOWS_SOURCE_RETIREMENT_SOURCE, "  static bool SetSourceDisposition(SafeFileHandle source,ref uint flags) {",
      "  [DllImport(\"kernel32.dll\",EntryPoint=\"SetLastError\",SetLastError=true)] static extern void SetRetirementTestError(uint error);\n" +
      "  static bool SetSourceDisposition(SafeFileHandle source,ref uint flags) { SetRetirementTestError(50); return false; }\n" +
      "  static bool SetSourceDispositionOriginal(SafeFileHandle source,ref uint flags) {");
    try {
      expect(runSource(source, f)).toMatchObject({ ok: false, phase: "delete", commit: "unknown", code: "ENOTSUP", windowsError: 50 });
      expect(await fs.readFile(f.source, "utf8")).toBe("payload A");
      expect(await fs.readFile(f.target, "utf8")).toBe("payload A");
      expect(fsSync.fstatSync(pin, { bigint: true }).nlink).toBe(2n);
    } finally { fsSync.closeSync(pin); }
  }, 35_000);

  it("reports consumed=true while preserving a reappeared publication source", async () => {
    const directory = await tempRoot("fs-safe-win-publish-reappear-");
    const sourcePath = path.join(directory, "source"), targetPath = path.join(directory, "target");
    await fs.writeFile(sourcePath, "payload A");
    vi.spyOn(retirement, "retireWindowsSourceNameSync").mockImplementationOnce(input => {
      retire(input); fsSync.writeFileSync(input.sourcePath, "replacement B", { flag: "wx" });
    });
    await expect(publishFileExclusive({ sourcePath, targetPath, strategy: "rename-noreplace" })).rejects.toMatchObject({
      code: "path-mismatch", details: { targetCreated: true, sourceConsumed: true, cleanup: "preserved" },
    });
    expect(await fs.readFile(sourcePath, "utf8")).toBe("replacement B");
    expect(await fs.readFile(targetPath, "utf8")).toBe("payload A");
  }, 35_000);
});
