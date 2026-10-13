import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWindowsSystemCommand } from "../../src/windows-command.js";

export const WINDOWS_SECURITY_SOURCE = fs.readFileSync(
  new URL("../../src/windows-security-bridge.cs", import.meta.url), "utf8",
);

export function runWindowsSecurityScript(
  source: string, body: readonly string[], env: NodeJS.ProcessEnv = {}, fd?: number, helperSource?: string,
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-win-test-script-"));
  try {
    fs.writeFileSync(path.join(directory, "windows-security-bridge.cs"), source, "utf8");
    // Transport fixtures replace the security bridge and never query owners.
    // Keep the unused dispatch arm fail-fast without importing real ACL code.
    if (helperSource) fs.writeFileSync(path.join(directory, "windows-owner-query.cs"),
      'public static class FsSafeWindowsOwnerQuery { public static object Execute(string path) { throw new System.InvalidOperationException("owner query is outside the transport fixture"); } }');
    if (helperSource) fs.writeFileSync(path.join(directory, "windows-security-helper.cs"), helperSource, "utf8");
    const script = path.join(directory, "windows-security-test.ps1");
    fs.writeFileSync(script, "\ufeff" + [
      "$ErrorActionPreference='Stop'",
      "$env:PSModulePath=[IO.Path]::Combine($PSHOME, 'Modules')",
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      helperSource
        ? "Microsoft.PowerShell.Utility\\Add-Type -LiteralPath @(([IO.Path]::Combine($PSScriptRoot, 'windows-security-bridge.cs')),([IO.Path]::Combine($PSScriptRoot, 'windows-security-helper.cs')),([IO.Path]::Combine($PSScriptRoot, 'windows-owner-query.cs')))"
        : "Microsoft.PowerShell.Utility\\Add-Type -LiteralPath ([IO.Path]::Combine($PSScriptRoot, 'windows-security-bridge.cs'))",
      ...body,
      "",
    ].join("\n"), "utf8");
    return execFileSync(resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`), [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File", script,
    ], {
      encoding: "utf8", windowsHide: true, timeout: 30_000,
      stdio: [fd ?? "ignore", "pipe", "pipe"], env: { ...process.env, ...env },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
