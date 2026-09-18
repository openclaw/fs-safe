import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { runWindowsMoveFixture, setWindowsMoveFixtureAcl } from "./helpers/windows-content-rights.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { renameFailures } from "./helpers/windows-rename-status-cases.js";

const { tempRoot } = useRealTempDirs();
const restricted = new Set<string>();
const moveSource = new URL("../src/windows-move-bridge.cs", import.meta.url);
const moveDriver = new URL("../src/windows-move-bridge.ps1", import.meta.url);
function exact(file: string): string {
  const st = fsSync.statSync(file, { bigint: true });
  return st.dev.toString(16).padStart(8, "0") + ":" + st.ino.toString(16).padStart(16, "0");
}
function rewrite(source: string, needle: string, replacement: string): string {
  expect(source.split(needle)).toHaveLength(2);
  return source.replace(needle, replacement);
}
function injectSyscall(source: string, body: string): string {
  const declaration = '  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle handle, out IoStatus io, IntPtr information, uint length, int kind);';
  return rewrite(source, declaration, declaration.replace('[DllImport("ntdll.dll")]',
    '[DllImport("ntdll.dll",EntryPoint="NtSetInformationFile",ExactSpelling=true)]').replace("NtSetInformationFile(", "NtSetInformationFileOriginal(") +
    "\n  static int NtSetInformationFile(SafeFileHandle handle,out IoStatus io,IntPtr information,uint length,int kind) { " + body + " }");
}
function restore(file: string): void {
  if (fsSync.existsSync(file)) setWindowsMoveFixtureAcl(file, false);
  restricted.delete(file);
}
afterEach(() => { for (const file of restricted) restore(file); });

describe.runIf(process.platform === "win32")("Windows move command OS-failure settlement", () => {
  it("matches native move error classes", () => {
    const expected = [
      [2, "ENOENT", "ENOENT"], [3, "ENOENT", "ENOENT"], [5, "EPERM", "EPERM"],
      [32, "EBUSY", "EBUSY"], [33, "EBUSY", "EBUSY"], [39, "ENOSPC", "ENOSPC"], [112, "ENOSPC", "ENOSPC"],
      [80, "EEXIST", "EEXIST"], [183, "EEXIST", "EEXIST"], [87, "EIO", "EINVAL"],
      [1, "EIO", "ENOTSUP"], [50, "EIO", "ENOTSUP"], [120, "EIO", "ENOTSUP"], [1117, "EIO", "EIO"],
    ] as const;
    const stdout = runWindowsMoveFixture({
      operation: "error-map",
      moveSource: fileURLToPath(moveSource), cases: expected,
    });
    expect(JSON.parse(stdout.trim())).toEqual({ rows: expected.flat() });
  }, 35_000);

  it.each(["prepare", "buffer-cleanup", "rejection-and-buffer-cleanup", "rename-io", "rename-io-and-close", "postcommit-substitution", "postcommit-substitution-and-close", "close"] as const)("preserves real filesystem state after %s", async fault => {
    const directory = await tempRoot("fs-safe-win-move-fault-");
    const sourcePath = path.join(directory, "source"), targetPath = path.join(directory, "target");
    const retired = targetPath + "-retired";
    await fs.writeFile(sourcePath, "owned payload");
    setWindowsMoveFixtureAcl(sourcePath, true);
    for (const file of [sourcePath, targetPath, retired]) restricted.add(file);
    const sourceIdentity = exact(sourcePath), parentIdentity = exact(directory);
    let source = await fs.readFile(moveSource, "utf8");
    // Only the selected OS action/settlement is replaced in this child-local
    // source copy. The production admission and post-operation guards execute.
    if (fault.includes("close")) {
      source = rewrite(source, "  static void CloseMoveHandle(SafeFileHandle handle) {",
        "  static int CloseFaultCalls; static void CloseMoveHandle(SafeFileHandle handle) { CloseMoveHandleOriginal(handle); if(++CloseFaultCalls==1) throw new Failure(\"EIO\",\"injected move close failure\"); }\n" +
        "  static void CloseMoveHandleOriginal(SafeFileHandle handle) {");
    }
    if (fault.includes("buffer-cleanup")) {
      source = rewrite(source, "      try { Marshal.FreeHGlobal(buffer); }",
        '      try { Marshal.FreeHGlobal(buffer); throw new Failure("EIO","injected rename buffer cleanup failure"); }');
    }
    if (fault === "prepare") {
      source = rewrite(source, "      Marshal.Copy(new byte[length],0,buffer,length);",
        '      Require(false,"ENOTSUP","injected rename preparation failure");\n      Marshal.Copy(new byte[length],0,buffer,length);');
    } else if (fault === "rejection-and-buffer-cleanup") {
      source = injectSyscall(source, "io=new IoStatus(); return unchecked((int)0xc0000022);");
    } else if (fault !== "close" && fault !== "buffer-cleanup") {
      const action = fault.startsWith("rename-io")
        ? "io=new IoStatus(); System.IO.File.WriteAllText(Environment.GetEnvironmentVariable(\"FS_SAFE_MOVE_TEST_TARGET\"),\"competitor\"); return unchecked((int)0xc0000185);"
        : "int result=NtSetInformationFileOriginal(handle,out io,information,length,kind); if(result>=0){string target=Environment.GetEnvironmentVariable(\"FS_SAFE_MOVE_TEST_TARGET\"); System.IO.File.Move(target,target+\"-retired\");System.IO.File.WriteAllText(target,\"replacement\");} return result;";
      source = injectSyscall(source, action);
    }
    const bundle = await tempRoot("fs-safe-win-move-bridge-");
    await fs.copyFile(moveDriver, path.join(bundle, "windows-move-bridge.ps1"));
    await fs.writeFile(path.join(bundle, "windows-move-bridge.cs"), source);
    const request = {
      scope: "root", rootPath: directory, rootIdentity: parentIdentity,
      sourceParentPath: directory, sourceRelative: "", sourceParentIdentity: parentIdentity,
      sourceName: "source", sourceIdentity,
      targetParentPath: directory, targetRelative: "", targetParentIdentity: parentIdentity, targetName: "target",
    };
    const stdout = execFileSync(resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(bundle, "windows-move-bridge.ps1"),
    ], {
      input: Buffer.from(JSON.stringify(request), "utf8"), encoding: "utf8", windowsHide: true, timeout: 30_000,
      env: { ...process.env, FS_SAFE_MOVE_TEST_TARGET: targetPath },
    });
    const result = JSON.parse(stdout.trim());
    if (fault.includes("close")) expect(result.cleanupError).toBe("injected move close failure");
    if (fault.includes("buffer-cleanup")) expect(result.cleanupError).toBe("injected rename buffer cleanup failure");
    if (fault === "rejection-and-buffer-cleanup") {
      expect(result).toMatchObject({ ok: false, phase: "rename", commit: "unknown", code: "EPERM", ntStatus: 0xc0000022 | 0, targetIdentity: null });
      expect(exact(sourcePath)).toBe(sourceIdentity);
      await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      restore(sourcePath); expect(await fs.readFile(sourcePath, "utf8")).toBe("owned payload");
    } else if (fault === "prepare") {
      expect(result).toMatchObject({ ok: false, phase: "admission", commit: "not-attempted", code: "ENOTSUP", ntStatus: null, targetIdentity: null });
      expect(exact(sourcePath)).toBe(sourceIdentity);
      await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      restore(sourcePath); expect(await fs.readFile(sourcePath, "utf8")).toBe("owned payload");
    } else if (fault === "buffer-cleanup") {
      expect(result).toMatchObject({ ok: false, phase: "verification", commit: "committed", code: "EIO", ntStatus: 0, targetIdentity: null });
      await expect(fs.lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(exact(targetPath)).toBe(sourceIdentity);
      restore(targetPath); expect(await fs.readFile(targetPath, "utf8")).toBe("owned payload");
    } else if (fault.startsWith("rename-io")) {
      expect(result).toMatchObject({ ok: false, phase: "rename", commit: "unknown", code: "EIO", ntStatus: -1073741435, targetIdentity: null });
      expect(exact(sourcePath)).toBe(sourceIdentity);
      expect(await fs.readFile(targetPath, "utf8")).toBe("competitor");
      restore(sourcePath); expect(await fs.readFile(sourcePath, "utf8")).toBe("owned payload");
    } else if (fault.startsWith("postcommit-substitution")) {
      expect(result).toMatchObject({ ok: false, phase: "verification", commit: "committed", code: "path-mismatch", ntStatus: 0 });
      await expect(fs.lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(exact(retired)).toBe(sourceIdentity);
      expect(await fs.readFile(targetPath, "utf8")).toBe("replacement");
      restore(retired); expect(await fs.readFile(retired, "utf8")).toBe("owned payload");
    } else {
      expect(result).toMatchObject({ ok: false, phase: "close", commit: "committed", code: "EIO", targetIdentity: sourceIdentity, cleanupError: "injected move close failure" });
      await expect(fs.lstat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(exact(targetPath)).toBe(sourceIdentity);
      restore(targetPath); expect(await fs.readFile(targetPath, "utf8")).toBe("owned payload");
    }
  }, 125_000);

  it("classifies actual negative NT results without changing their native error codes or filesystem state", async () => {
    const directory = await tempRoot("fs-safe-win-move-status-");
    const sourcePath = path.join(directory, "source"), targetPath = path.join(directory, "target");
    await fs.writeFile(sourcePath, "untouched source");
    const sourceIdentity = exact(sourcePath), parentIdentity = exact(directory);
    const before = await fs.stat(sourcePath, { bigint: true });
    const source = injectSyscall(await fs.readFile(moveSource, "utf8"),
      'io=new IoStatus(); return Int32.Parse(Environment.GetEnvironmentVariable("FS_SAFE_MOVE_TEST_NTSTATUS"),System.Globalization.CultureInfo.InvariantCulture);');
    const bundle = await tempRoot("fs-safe-win-move-status-bridge-");
    await fs.writeFile(path.join(bundle, "windows-move-bridge.cs"), source);
    const stdout = runWindowsMoveFixture({
      operation: "rename-statuses", moveSource: path.join(bundle, "windows-move-bridge.cs"), cases: renameFailures,
      move: { rootPath: directory, rootIdentity: parentIdentity,
        sourceParentPath: directory, sourceRelative: "", sourceParentIdentity: parentIdentity, sourceName: "source", sourceIdentity,
        targetParentPath: directory, targetRelative: "", targetParentIdentity: parentIdentity, targetName: "target" },
    });
    const results: unknown[] = JSON.parse(stdout);
    expect(results).toHaveLength(renameFailures.length);
    for (let index = 0; index < renameFailures.length; index++) {
      const expected = renameFailures[index]!;
      expect(results[index]).toMatchObject({ ok: false, phase: "rename", commit: "unknown",
        code: expected.code, ntStatus: expected.ntStatus, sourceIdentity, targetIdentity: null, cleanupError: null });
    }
    expect(await fs.stat(sourcePath, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, nlink: 1n, mode: before.mode });
    expect(await fs.readFile(sourcePath, "utf8")).toBe("untouched source");
    await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(directory)).toEqual(["source"]);
  }, 35_000);
});
