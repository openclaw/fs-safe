import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { isNodeError } from "../src/path.js";
import { fileStoreSync } from "../src/store.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { useSuiteFixture } from "./helpers/suite-fixture.js";

const COMMAND_TIMEOUT_MS = 20_000;
const PROOF_TIMEOUT_MS = COMMAND_TIMEOUT_MS * 4;
const DIAGNOSTIC_PREFIX = "FS_SAFE_ACL_DIAGNOSTIC:";

function safeDiagnostics(output: string): string {
  const reports: Record<string, string | number | boolean>[] = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith(DIAGNOSTIC_PREFIX)) continue;
    let value: unknown;
    try { value = JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length)); }
    catch { continue; }
    if (!value || typeof value !== "object") continue;
    const safe: Record<string, string | number | boolean> = {};
    for (const [key, field] of Object.entries(value)) {
      if (key === "phase" && typeof field === "string" && /^[a-z-]+$/u.test(field)) safe[key] = field;
      else if (key === "exceptionType" && typeof field === "string" && /^[A-Za-z0-9_.+]+$/u.test(field)) safe[key] = field;
      else if (key === "hresult" && typeof field === "string" && /^[0-9A-F]{8}$/u.test(field)) safe[key] = field;
      else if (["savedControlFlags", "restoredControlFlags", "savedAceCount", "restoredAceCount"].includes(key) &&
        typeof field === "number" && Number.isSafeInteger(field)) safe[key] = field;
      else if (["savedProtected", "restoredProtected", "aclBytesEqual"].includes(key) && typeof field === "boolean") safe[key] = field;
    }
    reports.push(safe);
  }
  return reports.length ? `; ${JSON.stringify(reports)}` : "";
}

function windowsCommand(command: string, args: string[], env: NodeJS.ProcessEnv, phase: string, cwd?: string): string {
  const result = spawnSync(resolveWindowsSystemCommand(command), args, {
    env, cwd, encoding: "utf8", windowsHide: true, timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    // ACL text contains account SIDs; keep command output out of public CI diagnostics.
    const details = safeDiagnostics(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    throw new Error(`Windows ACL proof ${phase} failed: ${path.win32.basename(command)} (${result.status ?? "no exit"})${details}`);
  }
  return result.stdout;
}

function powershell(source: string, env: NodeJS.ProcessEnv, phase: string): string {
  const wrapped = [
    "$ErrorActionPreference='Stop'",
    `$phase='${phase}'`,
    "$detail=@{}",
    `try { ${source} } catch {`,
    "$base=$_.Exception.GetBaseException()",
    "$detail.phase=$phase;$detail.exceptionType=$base.GetType().FullName;$detail.hresult=$base.HResult.ToString('X8')",
    `[Console]::Out.WriteLine('${DIAGNOSTIC_PREFIX}'+($detail|ConvertTo-Json -Compress))`,
    "exit 1 }",
  ].join(";");
  return windowsCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(wrapped, "utf16le").toString("base64"),
  ], env, phase);
}

describe.skipIf(process.platform !== "win32")("sync store real Windows ACL proof", () => {
  let directory: string;
  const withFixture = useSuiteFixture(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-store-acl-"));
    directory = await fs.realpath(directory);
    return directory;
  }, async () => {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }, PROOF_TIMEOUT_MS);

  it("preserves publication when a real read-data denial prevents opaque-name verification", () => withFixture(async () => {
    const target = path.join(directory, "target");
    const aclBackup = path.join(directory, "original.dacl");
    const payload = "synthetic Windows ACL publication";
    const env = { ...process.env, FS_SAFE_ACL_PROOF_TARGET: target };
    const open = fsSync.openSync.bind(fsSync);
    const close = fsSync.closeSync.bind(fsSync);
    const fstat = fsSync.fstatSync.bind(fsSync);
    const lstat = fsSync.lstatSync.bind(fsSync);
    const rename = fsSync.renameSync.bind(fsSync);
    let writerFd: number | undefined;
    let beforeDenial: BigIntStats | undefined;
    let savedAcl: { sid: string; sddl: string } | undefined;
    let aclBackupSaved = false;
    let denialApplied = false;
    let directOpenError: unknown;
    let verifierOpenError: unknown;
    let metadataProjected = false;
    let observedOpaquePath = false;
    let reads = 0;
    let failure: unknown;
    let libraryCode: string | undefined;
    try {
      vi.spyOn(fsSync, "openSync").mockImplementation((filePath, flags, mode) => {
        try {
          const fd = open(filePath, flags, mode);
          if (flags === "wx" && String(filePath).endsWith(".tmp")) writerFd = fd;
          return fd;
        } catch (error) {
          if (denialApplied && filePath === target) verifierOpenError = error;
          throw error;
        }
      });
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        if (!denialApplied || args[0] !== target || !stat.isFile()) return stat;
        const opaque = stat.dev === 0 || stat.dev === 0n || stat.ino === 0 || stat.ino === 0n;
        observedOpaquePath ||= opaque;
        if (opaque) return stat;
        metadataProjected = true;
        return Object.assign(Object.create(stat), {
          dev: typeof stat.dev === "bigint" ? 0n : 0,
          ino: typeof stat.ino === "bigint" ? 0n : 0,
        });
      });
      vi.spyOn(fsSync, "renameSync").mockImplementation((from, to) => {
        rename(from, to);
        if (to !== target) return;
        if (writerFd === undefined) throw new Error("publication writer was not captured");
        beforeDenial = fstat(writerFd, { bigint: true });
        close(open(target, fsSync.constants.O_RDONLY));
        const facts: unknown = JSON.parse(powershell([
          "$ErrorActionPreference='Stop'",
          "$section=[Security.AccessControl.AccessControlSections]::Access",
          "$acl=[IO.File]::GetAccessControl($env:FS_SAFE_ACL_PROOF_TARGET,$section)",
          "@{sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;sddl=$acl.GetSecurityDescriptorSddlForm($section)}|ConvertTo-Json -Compress",
        ].join(";"), env, "query-acl").trim());
        if (!facts || typeof facts !== "object" || !("sid" in facts) || !("sddl" in facts) ||
          typeof facts.sid !== "string" || !/^S-\d+(?:-\d+)+$/i.test(facts.sid) ||
          typeof facts.sddl !== "string" || !facts.sddl.startsWith("D:")) {
          throw new Error("Windows ACL proof returned invalid security facts");
        }
        savedAcl = { sid: facts.sid, sddl: facts.sddl };
        // Save a relative child name so native restore has an unambiguous directory root.
        windowsCommand("icacls.exe", ["target", "/save", aclBackup, "/q"], env, "save-acl", directory);
        aclBackupSaved = true;
        windowsCommand("icacls.exe", [target, "/deny", `*${savedAcl.sid}:(RD)`], env, "deny-read-data");
        denialApplied = true;
        try { close(open(target, fsSync.constants.O_RDONLY)); }
        catch (error) { directOpenError = error; }
        expect(fstat(writerFd, { bigint: true })).toMatchObject({
          dev: beforeDenial.dev, ino: beforeDenial.ino,
        });
      });
      const read = vi.spyOn(fsSync, "readSync");
      const readFile = vi.spyOn(fsSync, "readFileSync");
      let rejected: unknown;
      try { fileStoreSync({ rootDir: directory, durable: false }).write("target", payload); }
      catch (error) { rejected = error; }
      reads = read.mock.calls.length + readFile.mock.calls.length;
      expect(denialApplied).toBe(true);
      expect(isNodeError(directOpenError) && ["EACCES", "EPERM"].includes(directOpenError.code ?? "")).toBe(true);
      expect(isNodeError(verifierOpenError) && ["EACCES", "EPERM"].includes(verifierOpenError.code ?? "")).toBe(true);
      if (!(rejected instanceof FsSafeError)) throw new Error("opaque verification did not return FsSafeError");
      libraryCode = rejected.code;
      expect(rejected).toMatchObject({ code: "path-mismatch", cause: verifierOpenError });
      expect(reads).toBe(0);
      expect(() => fstat(writerFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      vi.restoreAllMocks();
      if (savedAcl && aclBackupSaved) {
        try {
          windowsCommand("icacls.exe", [directory, "/restore", aclBackup, "/q"], env, "restore-acl", directory);
          powershell([
            "$ErrorActionPreference='Stop'",
            "$section=[Security.AccessControl.AccessControlSections]::Access",
            "$phase='verify-acl'",
            "$restoredAcl=[IO.File]::GetAccessControl($env:FS_SAFE_ACL_PROOF_TARGET,$section)",
            "$restored=$restoredAcl.GetSecurityDescriptorSddlForm($section)",
            "$phase='compare-acl'",
            "if($restored -cne $env:FS_SAFE_ACL_PROOF_SDDL){",
            "$savedRaw=[Security.AccessControl.RawSecurityDescriptor]::new($env:FS_SAFE_ACL_PROOF_SDDL)",
            "$restoredRaw=[Security.AccessControl.RawSecurityDescriptor]::new($restored)",
            "$savedBytes=New-Object byte[] $savedRaw.DiscretionaryAcl.BinaryLength",
            "$restoredBytes=New-Object byte[] $restoredRaw.DiscretionaryAcl.BinaryLength",
            "$savedRaw.DiscretionaryAcl.GetBinaryForm($savedBytes,0);$restoredRaw.DiscretionaryAcl.GetBinaryForm($restoredBytes,0)",
            "$detail.savedControlFlags=[int]$savedRaw.ControlFlags;$detail.restoredControlFlags=[int]$restoredRaw.ControlFlags",
            "$detail.savedAceCount=$savedRaw.DiscretionaryAcl.Count;$detail.restoredAceCount=$restoredRaw.DiscretionaryAcl.Count",
            "$detail.savedProtected=([int]$savedRaw.ControlFlags -band 4096) -ne 0;$detail.restoredProtected=$restoredAcl.AreAccessRulesProtected",
            "$detail.aclBytesEqual=[Convert]::ToBase64String($savedBytes) -ceq [Convert]::ToBase64String($restoredBytes)",
            "throw 'ACL restoration mismatch'}",
          ].join(";"), { ...env, FS_SAFE_ACL_PROOF_SDDL: savedAcl.sddl }, "verify-acl");
        } catch (restoreError) {
          throw failure === undefined ? restoreError : new AggregateError([failure, restoreError], "ACL proof and restoration failed");
        }
      }
    }
    if (!beforeDenial) throw new Error("publication was not reached");
    const restored = await fs.open(target, "r");
    let contents: string;
    try {
      const current = await restored.stat({ bigint: true });
      expect(current).toMatchObject({ dev: beforeDenial.dev, ino: beforeDenial.ino, mode: beforeDenial.mode });
      contents = await restored.readFile("utf8");
    } finally {
      await restored.close();
    }
    expect(contents).toBe(payload);
    console.log(JSON.stringify({
      proof: "sync-store-windows-read-data-denial", entrypoint: "fileStoreSync.write",
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      ciCommit: process.env.GITHUB_SHA ?? null,
      realAclReadDataDenial: true,
      directOpenCode: isNodeError(directOpenError) ? directOpenError.code : null,
      verifierOpenCode: isNodeError(verifierOpenError) ? verifierOpenError.code : null,
      observedOpaquePath, metadataProjected, libraryCode, dataReadsDuringWrite: reads,
      retainedWriterSurvivedDenial: true, writerClosedAfterRejection: true,
      originalDaclRestored: true, restoreMethod: "icacls-save-restore", exactSddlMatched: true,
      publishedIdentityAndModePreserved: true,
      publishedBytes: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex"),
    }));
  }), PROOF_TIMEOUT_MS);
});
