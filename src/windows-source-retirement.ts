import { spawnSync } from "node:child_process";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { FsSafeError, type FsSafeErrorCode } from "./errors.js";
import { DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, PermissionCommandError } from "./permission-exec.js";
import { resolveWindowsSystemCommand } from "./windows-command.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { WINDOWS_SOURCE_RETIREMENT_SOURCE } from "./windows-source-retirement-source.js";

type Identity = { dev: bigint; ino: bigint };
export type WindowsSourceRetirementInput = {
  sourcePath: string;
  sourceParentPath: string;
  sourceParentIdentity: Identity;
  identity: Identity;
  expectedLinks: bigint;
};
const LIMIT = 1024 * 1024;
const PHASES = new Set(["admission", "delete", "close-delete", "verification", "complete", "close"]);
const CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOSPC", "ENOENT", "ENOTSUP", "EINVAL", "EIO", "EBADF", "ELOOP", "ENOTDIR", "path-mismatch", "invalid-path"]);
let encodedSource: string | undefined;

function exact(value: Identity): string {
  if (typeof value.dev !== "bigint" || typeof value.ino !== "bigint" || value.dev <= 0n || value.dev > 0xffff_ffffn || value.ino <= 0n || value.ino > 0xffff_ffff_ffff_ffffn) {
    throw new FsSafeError("path-mismatch", "retirement requires an exact known identity", { details: { commit: "not-attempted" } });
  }
  return value.dev.toString(16).padStart(8, "0") + ":" + value.ino.toString(16).padStart(16, "0");
}
function snapshot(input: WindowsSourceRetirementInput) {
  const sourcePath = input.sourcePath;
  const parentPath = input.sourceParentPath;
  for (const value of [sourcePath, parentPath]) {
    if (typeof value !== "string" || !path.win32.isAbsolute(value) || value.includes("\0")) {
      throw new FsSafeError("invalid-path", "retirement requires absolute paths", { details: { commit: "not-attempted" } });
    }
    try { assertNoWindowsPathAlias(value, "filesystem", "retirement path uses a Windows namespace alias", "win32"); }
    catch (cause) {
      throw new FsSafeError("invalid-path", "retirement path uses a Windows namespace alias", { cause, details: { commit: "not-attempted" } });
    }
  }
  if (path.win32.normalize(path.win32.dirname(sourcePath)).toLowerCase() !== path.win32.normalize(parentPath).toLowerCase()) {
    throw new FsSafeError("path-mismatch", "retirement source must belong to its admitted parent", { details: { commit: "not-attempted" } });
  }
  const sourceName = path.win32.basename(sourcePath);
  if (!sourceName || sourceName === "." || sourceName === ".." || sourceName.endsWith(".") || sourceName.endsWith(" ") ||
      typeof input.expectedLinks !== "bigint" || input.expectedLinks < 2n || input.expectedLinks > 0xffff_ffffn) {
    throw new FsSafeError("invalid-path", "retirement requires a child and a surviving published link", { details: { commit: "not-attempted" } });
  }
  return { parentPath, parentIdentity: exact(input.sourceParentIdentity), sourceName, sourceIdentity: exact(input.identity), expectedLinks: Number(input.expectedLinks) };
}
function command() {
  encodedSource ??= gzipSync(WINDOWS_SOURCE_RETIREMENT_SOURCE).toString("base64");
  const script = [
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
    `$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${encodedSource}'),$false)`,
    "$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress)",
    "$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8)",
    "try{Add-Type -TypeDefinition $r.ReadToEnd()}finally{$r.Dispose();$g.Dispose();$m.Dispose()}",
    "$u=[Text.UTF8Encoding]::new($false,$true)",
    "$p=ConvertFrom-Json ($u.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))",
    "[FsSafeWindowsBridge]::ExecuteRetirement($p.parentPath,$p.parentIdentity,$p.sourceName,$p.sourceIdentity,$p.expectedLinks)|ConvertTo-Json -Depth 8 -Compress",
  ].join(";");
  return { file: resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function unknown(cause?: unknown): never {
  throw new FsSafeError("helper-failed", "Windows source retirement outcome could not be verified", { cause, details: { phase: "transport", commit: "unknown" } });
}
function parse(stdout: string, request: ReturnType<typeof snapshot>): void {
  let value: unknown;
  try { value = JSON.parse(stdout.trim()); } catch (cause) { unknown(cause); }
  if (!record(value) || typeof value.ok !== "boolean" || typeof value.phase !== "string" || !PHASES.has(value.phase) ||
      typeof value.commit !== "string" || !["not-attempted", "unknown", "committed"].includes(value.commit) || value.sourceIdentity !== request.sourceIdentity || value.expectedLinks !== request.expectedLinks ||
      (value.remainingLinks !== null && value.remainingLinks !== request.expectedLinks - 1) ||
      (value.readOnlyBefore !== null && typeof value.readOnlyBefore !== "boolean") || (value.readOnlyAfter !== null && typeof value.readOnlyAfter !== "boolean") ||
      (value.windowsError !== null && (typeof value.windowsError !== "number" || !Number.isInteger(value.windowsError) || value.windowsError < 0 || value.windowsError > 0xffff_ffff)) ||
      (value.cleanupError !== null && typeof value.cleanupError !== "string")) unknown();
  const details = { phase: value.phase, commit: value.commit, windowsError: value.windowsError, cleanupError: value.cleanupError };
  if (value.ok) {
    if (value.phase !== "complete" || value.commit !== "committed" || value.remainingLinks !== request.expectedLinks - 1 ||
        typeof value.readOnlyBefore !== "boolean" || value.readOnlyAfter !== value.readOnlyBefore ||
        value.code !== null || value.message !== null || value.windowsError !== null || value.cleanupError !== null) unknown();
    return;
  }
  if (typeof value.code !== "string" || !CODES.has(value.code) || typeof value.message !== "string" || value.phase === "complete" ||
      (value.commit !== "committed" && (value.remainingLinks !== null || value.readOnlyAfter !== null)) ||
      (value.windowsError !== null && value.phase !== "delete") ||
      (value.phase === "admission" && value.commit !== "not-attempted") ||
      ((value.phase === "delete" || value.phase === "close-delete") && value.commit !== "unknown") ||
      ((value.phase === "verification" || value.phase === "close") && value.commit !== "committed")) unknown();
  const cause = Object.assign(new Error(value.message), { code: value.code, ...details });
  const code: FsSafeErrorCode = value.commit !== "committed" && (value.code === "path-mismatch" || value.code === "invalid-path") ? value.code : "helper-failed";
  throw new FsSafeError(code, "Windows source retirement failed", { cause, details });
}

/** The caller retains its fd for identity custody; only the source-opened handle is deleted. */
export function retireWindowsSourceNameSync(input: WindowsSourceRetirementInput): void {
  const request = snapshot(input);
  const bytes = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  if (bytes.length > LIMIT) throw new FsSafeError("invalid-path", "retirement request exceeds its budget", { details: { commit: "not-attempted" } });
  const { file, args } = command();
  const started = performance.now();
  const result = spawnSync(file, args, { input: bytes, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: LIMIT });
  if (result.error || result.status !== 0 || result.signal !== null) {
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    unknown(new PermissionCommandError(file, performance.now() - started, { cause: result.error, code: result.status, signal: timedOut ? "SIGKILL" : result.signal, killed: timedOut, stderr: result.stderr }));
  }
  parse(result.stdout, request);
}
