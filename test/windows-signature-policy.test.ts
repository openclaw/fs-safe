import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, windowsFiles, windowsSigner } from "../scripts/windows-signing.mjs";

// Exercise the Windows verifier's decisions with synthetic signature API replies.
// Real signing and WinVerifyTrust are exercised only by the release dry run.
describe.skipIf(process.platform !== "win32")("Windows Authenticode policy", () => {
  it.each(["valid", "unsigned", "wrong-signer", "no-timestamp", "catalog", "unchanged"])("handles %s signatures", (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), "fs-safe-signature-policy-"));
    try {
      const hashes = Object.fromEntries(windowsFiles.map(({ file }: { file: string }) => {
        writeFileSync(join(directory, file), "synthetic signed bytes");
        return [file, sha256(scenario === "unchanged" ? "synthetic signed bytes" : "synthetic unsigned bytes")];
      }));
      writeFileSync(join(directory, "unsigned-windows-sha256.json"), JSON.stringify(hashes));
      const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
        $ErrorActionPreference = 'Stop'
        function Get-AuthenticodeSignature {
          param($LiteralPath)
          [pscustomobject]@{
            Status = '${scenario === "unsigned" ? "NotSigned" : "Valid"}'
            SignerCertificate = [pscustomobject]@{ Subject = '${scenario === "wrong-signer" ? "CN=Someone else" : windowsSigner}' }
            TimeStamperCertificate = ${scenario === "no-timestamp" ? "$null" : "[pscustomobject]@{ Thumbprint = '" + "1".repeat(40) + "' }"}
            SignatureType = '${scenario === "catalog" ? "Catalog" : "Authenticode"}'
          }
        }
        & $env:FS_SAFE_VERIFIER -Directory $env:FS_SAFE_SIGNATURE_FIXTURE -Record
        & $env:FS_SAFE_VERIFIER -Directory $env:FS_SAFE_SIGNATURE_FIXTURE
      `], {
        env: { ...process.env, FS_SAFE_VERIFIER: resolve("scripts/verify-windows-signatures.ps1"), FS_SAFE_SIGNATURE_FIXTURE: directory },
        encoding: "utf8", timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      if (scenario === "valid") expect(result.status, result.stderr).toBe(0);
      else expect(result.status, result.stderr).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 35_000);
});
