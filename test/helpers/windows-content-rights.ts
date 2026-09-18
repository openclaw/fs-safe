import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { resolveWindowsSystemCommand } from "../../src/windows-command.js";

/** Synthetic fixture setup: deny data access while preserving metadata/delete. */
export function setWindowsMoveFixtureAcl(targetPath: string, restricted: boolean): void {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=[Environment]::GetEnvironmentVariable('FS_SAFE_MOVE_FIXTURE_PATH')",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$a=[Security.AccessControl.FileSecurity]::new();$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false)",
    ...(restricted ? ["$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]7,[Security.AccessControl.AccessControlType]::Deny))"] : []),
    `$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]${restricted ? 0x00130180 : 0x001f01ff},[Security.AccessControl.AccessControlType]::Allow))`,
    "[IO.File]::SetAccessControl($p,$a)",
  ].join(";");
  execFileSync(resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { windowsHide: true, stdio: "pipe", timeout: 30_000, env: { ...process.env, FS_SAFE_MOVE_FIXTURE_PATH: targetPath } });
}

export function windowsMoveDataOpenError(targetPath: string, flags: number): string | undefined {
  let fd: number | undefined;
  try { fd = fs.openSync(targetPath, flags); }
  catch (error) { return (error as NodeJS.ErrnoException).code; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return undefined;
}
