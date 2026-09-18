import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WINDOWS_MOVE_SOURCE } from "../src/windows-move-source.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { setWindowsMoveFixtureAcl } from "./helpers/windows-content-rights.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const restricted = new Set<string>();
function exact(file: string): string {
  const st = fsSync.statSync(file, { bigint: true });
  return st.dev.toString(16).padStart(8, "0") + ":" + st.ino.toString(16).padStart(16, "0");
}
function rewrite(source: string, needle: string, replacement: string): string {
  expect(source.split(needle)).toHaveLength(2);
  return source.replace(needle, replacement);
}
function restore(file: string): void {
  if (fsSync.existsSync(file)) setWindowsMoveFixtureAcl(file, false);
  restricted.delete(file);
}
afterEach(() => { for (const file of restricted) restore(file); });

describe.runIf(process.platform === "win32")("Windows move command OS-failure settlement", () => {
  it("matches native move error classes while keeping security inspection's mapping", () => {
    const expected = [
      [2, "ENOENT", "ENOENT"], [3, "ENOENT", "ENOENT"], [5, "EPERM", "EPERM"],
      [32, "EBUSY", "EBUSY"], [33, "EBUSY", "EBUSY"], [39, "ENOSPC", "ENOSPC"], [112, "ENOSPC", "ENOSPC"],
      [80, "EEXIST", "EEXIST"], [183, "EEXIST", "EEXIST"], [87, "EIO", "EINVAL"],
      [1, "EIO", "ENOTSUP"], [50, "EIO", "ENOTSUP"], [120, "EIO", "ENOTSUP"], [1117, "EIO", "EIO"],
    ] as const;
    const query = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -TypeDefinition ([Console]::In.ReadToEnd())",
      "$flags=[Reflection.BindingFlags]::NonPublic -bor [Reflection.BindingFlags]::Static",
      "$move=[FsSafeWindowsBridge].GetMethod('MoveOsFailure',$flags);$security=[FsSafeWindowsBridge].GetMethod('OsFailure',$flags)",
      "$cases=ConvertFrom-Json ([Environment]::GetEnvironmentVariable('FS_SAFE_MOVE_ERROR_CASES'))",
      "$rows=@($cases|ForEach-Object{$number=[uint32]$_[0];@($number,$move.Invoke($null,@($number,'probe',$false)).Code,$move.Invoke($null,@($number,'probe',$true)).Code)})",
      "@{rows=$rows;securityAccessDenied=$security.Invoke($null,@([uint32]5,'probe')).Code}|ConvertTo-Json -Depth 8 -Compress",
    ].join(";");
    const stdout = execFileSync(resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query,
    ], { input: WINDOWS_MOVE_SOURCE, encoding: "utf8", windowsHide: true, timeout: 30_000, env: { ...process.env, FS_SAFE_MOVE_ERROR_CASES: JSON.stringify(expected) } });
    expect(JSON.parse(stdout.trim())).toEqual({ rows: expected.flat(), securityAccessDenied: "EACCES" });
  }, 35_000);

  it.each(["rename-io", "postcommit-substitution", "close"] as const)("preserves real filesystem state after %s", async fault => {
    const directory = await tempRoot("fs-safe-win-move-fault-");
    const sourcePath = path.join(directory, "source"), targetPath = path.join(directory, "target");
    const retired = targetPath + "-retired";
    await fs.writeFile(sourcePath, "owned payload");
    setWindowsMoveFixtureAcl(sourcePath, true);
    for (const file of [sourcePath, targetPath, retired]) restricted.add(file);
    const sourceIdentity = exact(sourcePath), parentIdentity = exact(directory);
    let source = WINDOWS_MOVE_SOURCE;
    // Only the selected OS action/settlement is replaced in this child-local
    // source copy. The production admission and post-operation guards execute.
    if (fault === "close") {
      source = rewrite(source, "  static void CloseMoveHandle(SafeFileHandle handle) {",
        "  static int CloseFaultCalls; static void CloseMoveHandle(SafeFileHandle handle) { CloseMoveHandleOriginal(handle); if(++CloseFaultCalls==1) throw new Failure(\"EIO\",\"injected move close failure\"); }\n" +
        "  static void CloseMoveHandleOriginal(SafeFileHandle handle) {");
    } else {
      const signature = "  static int RenameMoveHandle(SafeFileHandle source,SafeFileHandle targetParent,string targetName) {";
      const action = fault === "rename-io"
        ? "System.IO.File.WriteAllText(Environment.GetEnvironmentVariable(\"FS_SAFE_MOVE_TEST_TARGET\"),\"competitor\"); return unchecked((int)0xc0000185);"
        : "int result=RenameMoveHandleOriginal(source,targetParent,targetName); if(result>=0){string target=Environment.GetEnvironmentVariable(\"FS_SAFE_MOVE_TEST_TARGET\"); System.IO.File.Move(target,target+\"-retired\");System.IO.File.WriteAllText(target,\"replacement\");} return result;";
      source = rewrite(source, signature,
        signature + action + " }\n  static int RenameMoveHandleOriginal(SafeFileHandle source,SafeFileHandle targetParent,string targetName) {");
    }
    const parameters = [directory, parentIdentity, directory, "", parentIdentity, "source", sourceIdentity, directory, "", parentIdentity, "target"];
    const query = [
      "$ErrorActionPreference='Stop'",
      "Add-Type -TypeDefinition ([Console]::In.ReadToEnd())",
      "$p=ConvertFrom-Json ([Environment]::GetEnvironmentVariable('FS_SAFE_MOVE_TEST_PARAMETERS'))",
      "[FsSafeWindowsBridge]::ExecuteMove($p[0],$p[1],$p[2],$p[3],$p[4],$p[5],$p[6],$p[7],$p[8],$p[9],$p[10])|ConvertTo-Json -Depth 8 -Compress",
    ].join(";");
    const stdout = execFileSync(resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", query,
    ], {
      input: source, encoding: "utf8", windowsHide: true, timeout: 30_000,
      env: { ...process.env, FS_SAFE_MOVE_TEST_PARAMETERS: JSON.stringify(parameters), FS_SAFE_MOVE_TEST_TARGET: targetPath },
    });
    const result = JSON.parse(stdout.trim());
    if (fault === "rename-io") {
      expect(result).toMatchObject({ ok: false, phase: "rename", commit: "unknown", code: "EIO", ntStatus: -1073741435, targetIdentity: null });
      expect(exact(sourcePath)).toBe(sourceIdentity);
      expect(await fs.readFile(targetPath, "utf8")).toBe("competitor");
      restore(sourcePath); expect(await fs.readFile(sourcePath, "utf8")).toBe("owned payload");
    } else if (fault === "postcommit-substitution") {
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
});
