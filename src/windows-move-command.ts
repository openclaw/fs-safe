import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FsSafeError, type FsSafeErrorCode } from "./errors.js";
import type { RootMoveCommandInput } from "./atomic-rename-command.js";
import { DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, PermissionCommandError } from "./permission-exec.js";
import { resolveWindowsSystemCommand } from "./windows-command.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

const LIMIT = 1024 * 1024;
const PHASES = new Set(["admission", "rename", "verification", "complete", "close"]);
const COMMITS = new Set(["not-attempted", "unknown", "committed"]);
const POLICY_CODES = new Set<FsSafeErrorCode>(["path-mismatch", "invalid-path", "symlink", "hardlink", "not-file"]);
const OS_CODES = new Set(["EACCES", "EPERM", "EBUSY", "ENOSPC", "EEXIST", "ENOENT", "ENOTSUP", "EIO", "EBADF", "ELOOP", "ENOTDIR", "EINVAL"]);

type Identity = { dev: bigint | number; ino: bigint | number };

function invalid(message: string): never {
  throw new FsSafeError("invalid-path", message);
}
function identity(value: Identity): string {
  const integer = (number: bigint | number, maximum: bigint) => {
    if (typeof number !== "bigint" && (typeof number !== "number" || !Number.isSafeInteger(number))) {
      throw new FsSafeError("path-mismatch", "Windows move requires an exact identity");
    }
    const result = BigInt(number);
    if (result <= 0n || result > maximum) throw new FsSafeError("path-mismatch", "Windows move identity is unknown or out of range");
    return result;
  };
  return integer(value.dev, 0xffff_ffffn).toString(16).padStart(8, "0") + ":" +
    integer(value.ino, 0xffff_ffff_ffff_ffffn).toString(16).padStart(16, "0");
}
function canonicalPath(value: string): string {
  if (typeof value !== "string" || !path.win32.isAbsolute(value) || value.includes("\0")) invalid("Windows move requires canonical absolute paths");
  assertNoWindowsPathAlias(value, "filesystem", "Windows move path uses a filesystem namespace alias", "win32");
  return filesystemString(value);
}
function filesystemString(value: string): string {
  // Node converts filesystem strings through UTF-8, replacing lone surrogates.
  // JSON alone would preserve them and dispatch a different UTF-16 pathname.
  return Buffer.from(value, "utf8").toString("utf8");
}
function relativePath(value: string, basename = false): string {
  if (typeof value !== "string" || value.includes("\0") || value.includes(":")) invalid("Windows move requires relative components");
  const normalized = value.replaceAll("/", "\\");
  if (!basename && normalized === "") return normalized;
  const components = normalized.split("\\");
  if ((basename && components.length !== 1) || components.some(part => !part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" "))) {
    invalid("Windows move has an invalid relative component");
  }
  return filesystemString(normalized);
}
function snapshot(input: RootMoveCommandInput) {
  // The child opens its own Windows handles. Only admitted paths, names and
  // exact identity receipts cross this process boundary, never CRT descriptors.
  return {
    scope: "root" as const,
    rootPath: canonicalPath(input.root.path), rootIdentity: identity(input.root.identity),
    sourceParentPath: canonicalPath(input.source.parentPath), sourceRelative: relativePath(input.source.parentRelativePath),
    sourceParentIdentity: identity(input.source.parentIdentity), sourceName: relativePath(input.source.basename, true),
    sourceIdentity: identity(input.source.identity),
    targetParentPath: canonicalPath(input.target.parentPath), targetRelative: relativePath(input.target.parentRelativePath),
    targetParentIdentity: identity(input.target.parentIdentity), targetName: relativePath(input.target.basename, true),
  };
}
function command(): { file: string; args: string[] } {
  return {
    file: resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./windows-move-bridge.ps1", import.meta.url))],
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function unverified(cause?: unknown): never {
  throw new FsSafeError("helper-failed", "Windows atomic move outcome could not be verified", {
    cause, details: { phase: "transport", commit: "unknown" },
  });
}
function preparationFailed(cause: unknown): never {
  throw new FsSafeError(cause instanceof FsSafeError ? cause.code : "helper-failed",
    cause instanceof FsSafeError ? cause.message : "Windows atomic move could not be prepared", {
      cause, details: { phase: "admission", commit: "not-attempted" },
    });
}
function parseReceipt(text: string, expected: string): void {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch (cause) { unverified(cause); }
  if (!record(value) || typeof value.ok !== "boolean" || typeof value.phase !== "string" || !PHASES.has(value.phase) ||
      typeof value.commit !== "string" || !COMMITS.has(value.commit) || value.sourceIdentity !== expected ||
      (value.targetIdentity !== null && value.targetIdentity !== expected) ||
      (value.cleanupError !== null && typeof value.cleanupError !== "string") ||
      (value.ntStatus !== null && (typeof value.ntStatus !== "number" || !Number.isInteger(value.ntStatus) || value.ntStatus < -0x8000_0000 || value.ntStatus > 0x7fff_ffff))) {
    unverified();
  }
  const details = { phase: value.phase, commit: value.commit, ntStatus: value.ntStatus, cleanupError: value.cleanupError,
    ...(value.commit === "committed" ? { sourceConsumed: true as const } : {}) };
  if (value.ok) {
    if (value.phase !== "complete" || value.commit !== "committed" || value.targetIdentity !== expected ||
        typeof value.ntStatus !== "number" || value.ntStatus < 0 || value.code !== null || value.message !== null || value.cleanupError !== null) {
      unverified();
    }
    return;
  }
  if (typeof value.code !== "string" || typeof value.message !== "string" ||
      (!OS_CODES.has(value.code) && !POLICY_CODES.has(value.code as FsSafeErrorCode)) ||
      (value.phase === "admission" && (value.commit !== "not-attempted" || value.ntStatus !== null)) ||
      (value.phase === "rename" && (value.commit !== "unknown" ||
        (typeof value.ntStatus === "number" && value.ntStatus >= 0))) ||
      ((value.phase === "verification" || value.phase === "close") && value.commit !== "committed") ||
      (value.commit === "committed" && (typeof value.ntStatus !== "number" || value.ntStatus < 0)) ||
      (value.commit !== "committed" && value.targetIdentity !== null) ||
      value.phase === "complete") {
    unverified();
  }
  const cause = Object.assign(new Error(value.message), { code: value.code, ...details });
  if (value.commit === "committed") {
    throw new FsSafeError("helper-failed", "Windows atomic move committed but final verification or cleanup failed", { cause, details });
  }
  if (value.commit === "not-attempted" && (value.code === "ENOTSUP" || value.code === "EINVAL")) {
    throw new FsSafeError("helper-unavailable", "Windows atomic no-replace rename is unavailable", { cause, details });
  }
  if (POLICY_CODES.has(value.code as FsSafeErrorCode)) {
    throw new FsSafeError(value.code as FsSafeErrorCode, value.message, { cause, details });
  }
  throw cause;
}

function dispatch(request: ReturnType<typeof snapshot>): void {
  // The fixed driver reads raw bytes and decodes strict UTF-8, independently of
  // PowerShell 5.1's redirected-console codepage.
  let input: Buffer;
  let file: string;
  let args: string[];
  try {
    input = Buffer.from(JSON.stringify(request), "utf8");
    if (input.length > LIMIT) invalid("Windows move request exceeds its input budget");
    ({ file, args } = command());
  } catch (cause) { preparationFailed(cause); }
  const started = performance.now();
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(file, args, {
      input, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      timeout: DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: LIMIT,
    });
  } catch (cause) { unverified(cause); }
  if (result.error || result.status !== 0 || result.signal !== null) {
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const timedOut = errorCode === "ETIMEDOUT";
    const cause = new PermissionCommandError(file, performance.now() - started, {
      cause: result.error, code: result.status, signal: timedOut ? "SIGKILL" : result.signal,
      killed: timedOut, stderr: result.stderr,
    });
    if (result.error && result.pid === 0 && result.status === null && result.signal === null) {
      const code = ["ENOENT", "EACCES", "ENOEXEC"].includes(errorCode ?? "") ? "helper-unavailable" : "helper-failed";
      throw new FsSafeError(code, "Windows atomic move command could not start", {
        cause, details: { phase: "transport", commit: "not-attempted" },
      });
    }
    unverified(cause);
  }
  if (typeof result.stdout !== "string") unverified();
  parseReceipt(result.stdout, request.sourceIdentity);
}

/** One synchronous dispatch after the shared owner settles policy and live authority. */
export function moveWindowsMetadataNoReplaceSync(input: RootMoveCommandInput): void {
  let request: ReturnType<typeof snapshot>;
  try { request = snapshot(input); } catch (cause) { preparationFailed(cause); }
  dispatch(request);
}
