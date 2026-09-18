import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWindowsSystemCommand } from "../../src/windows-command.js";

export const WINDOWS_SECURITY_SOURCE = fs.readFileSync(
  new URL("../../src/windows-security-bridge.cs", import.meta.url), "utf8",
);

export function runWindowsSecurityScript(
  source: string, body: readonly string[], env: NodeJS.ProcessEnv = {}, fd?: number,
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fs-safe-win-test-script-"));
  try {
    fs.writeFileSync(path.join(directory, "windows-security-bridge.cs"), source, "utf8");
    const script = path.join(directory, "windows-security-test.ps1");
    fs.writeFileSync(script, "\ufeff" + [
      "$ErrorActionPreference='Stop'",
      "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
      "Add-Type -LiteralPath (Join-Path $PSScriptRoot 'windows-security-bridge.cs')",
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
