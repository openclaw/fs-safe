import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveWindowsSystemCommand } from "../../src/windows-command.js";

const fixturePath = fileURLToPath(new URL("../fixtures/windows-move-fixture.ps1", import.meta.url));
const inputLimit = 1024 * 1024;

export function runWindowsMoveFixture(request: Record<string, unknown>): string {
  const input = Buffer.from(JSON.stringify(request), "utf8");
  if (input.byteLength > inputLimit) throw new RangeError("Windows move fixture request exceeds its input budget");
  return execFileSync(resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", fixturePath,
  ], { input, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, maxBuffer: inputLimit });
}

/** Synthetic fixture setup: deny data access while preserving metadata/delete. */
export function setWindowsMoveFixtureAcl(targetPath: string, restricted: boolean): void {
  runWindowsMoveFixture({ operation: "file-acl", path: targetPath, restricted });
}
