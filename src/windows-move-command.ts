import { spawnSync } from "node:child_process";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { FsSafeError, type FsSafeErrorCode } from "./errors.js";
import type { RootMoveCommandInput } from "./root-move-command.js";
import { DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, PermissionCommandError } from "./permission-exec.js";
import { resolveWindowsSystemCommand } from "./windows-command.js";
import { WINDOWS_MOVE_SOURCE } from "./windows-move-source.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

const LIMIT = 1024 * 1024;
const PHASES = new Set(["admission", "rename", "verification", "complete", "close"]);
const COMMITS = new Set(["not-attempted", "unknown", "committed"]);
const POLICY_CODES = new Set<FsSafeErrorCode>(["path-mismatch", "invalid-path", "symlink", "hardlink", "not-file"]);
const OS_CODES = new Set(["EACCES", "EPERM", "EBUSY", "ENOSPC", "EEXIST", "ENOENT", "ENOTSUP", "EIO", "EBADF", "ELOOP", "ENOTDIR", "EINVAL"]);
// STATUS_OBJECT_NAME_COLLISION and STATUS_DIRECTORY_NOT_EMPTY.
const COLLISION_STATUSES = new Set([-1073741771, -1073741567]);
let encodedSource: string | undefined;

type Identity = { dev: bigint | number; ino: bigint | number };
type FileMoveParent = { parentPath: string; parentIdentity: Identity; basename: string };
export type WindowsFileMoveCommandInput = {
  source: FileMoveParent & { identity: Identity; expectedLinks: bigint };
  target: FileMoveParent;
};

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
  return value;
}
function relativePath(value: string, basename = false): string {
  if (typeof value !== "string" || value.includes("\0") || value.includes(":")) invalid("Windows move requires relative components");
  const normalized = value.replaceAll("/", "\\");
  if (!basename && normalized === "") return normalized;
  const components = normalized.split("\\");
  if ((basename && components.length !== 1) || components.some(part => !part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" "))) {
    invalid("Windows move has an invalid relative component");
  }
  return normalized;
}
function snapshot(input: RootMoveCommandInput) {
  // Parent descriptors remain owned by the JS admission layer. Only its paths,
  // names and exact receipts cross this process boundary.
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
function fileSnapshot(input: WindowsFileMoveCommandInput) {
  const links = input.source.expectedLinks;
  if (typeof links !== "bigint" || links < 1n || links > 0xffff_ffffn) {
    throw new FsSafeError("path-mismatch", "Windows move requires an exact positive link count");
  }
  return {
    scope: "parents" as const,
    sourceParentPath: canonicalPath(input.source.parentPath), sourceParentIdentity: identity(input.source.parentIdentity),
    sourceName: relativePath(input.source.basename, true), sourceIdentity: identity(input.source.identity), expectedLinks: links.toString(),
    targetParentPath: canonicalPath(input.target.parentPath), targetParentIdentity: identity(input.target.parentIdentity),
    targetName: relativePath(input.target.basename, true),
  };
}
function command(): { file: string; args: string[] } {
  encodedSource ??= gzipSync(WINDOWS_MOVE_SOURCE).toString("base64");
  const script = [
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
    `$m=[IO.MemoryStream]::new([Convert]::FromBase64String('${encodedSource}'),$false)`,
    "$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress)",
    "$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8)",
    "try{Add-Type -TypeDefinition $r.ReadToEnd()}finally{$r.Dispose();$g.Dispose();$m.Dispose()}",
    "$u=[Text.UTF8Encoding]::new($false,$true)",
    "$p=ConvertFrom-Json ($u.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))",
    "if($p.scope -eq 'parents'){[FsSafeWindowsBridge]::ExecuteFileMove($p.sourceParentPath,$p.sourceParentIdentity,$p.sourceName,$p.sourceIdentity,[uint32]$p.expectedLinks,$p.targetParentPath,$p.targetParentIdentity,$p.targetName)|ConvertTo-Json -Depth 8 -Compress}else{[FsSafeWindowsBridge]::ExecuteMove($p.rootPath,$p.rootIdentity,$p.sourceParentPath,$p.sourceRelative,$p.sourceParentIdentity,$p.sourceName,$p.sourceIdentity,$p.targetParentPath,$p.targetRelative,$p.targetParentIdentity,$p.targetName)|ConvertTo-Json -Depth 8 -Compress}",
  ].join(";");
  return {
    file: resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
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
  const details = { phase: value.phase, commit: value.commit, ntStatus: value.ntStatus, cleanupError: value.cleanupError };
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
      (value.phase === "rename" && ((value.commit !== "unknown" && !(value.commit === "not-attempted" && value.code === "EEXIST" && COLLISION_STATUSES.has(value.ntStatus as number))) ||
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
  if (POLICY_CODES.has(value.code as FsSafeErrorCode)) {
    throw new FsSafeError(value.code as FsSafeErrorCode, value.message, { cause, details });
  }
  throw cause;
}

function dispatch(request: ReturnType<typeof snapshot> | ReturnType<typeof fileSnapshot>): void {
  // PS 5.1 may decode redirected stdin using its console codepage. ASCII
  // base64 carries the exact UTF-8 JSON independently of that codepage.
  const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  if (encoded.length > LIMIT) invalid("Windows move request exceeds its input budget");
  const { file, args } = command();
  const started = performance.now();
  const result = spawnSync(file, args, {
    input: encoded, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    timeout: DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: LIMIT,
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    unverified(new PermissionCommandError(file, performance.now() - started, {
      cause: result.error, code: result.status, signal: timedOut ? "SIGKILL" : result.signal,
      killed: timedOut, stderr: result.stderr,
    }));
  }
  parseReceipt(result.stdout, request.sourceIdentity);
}

/** One synchronous dispatch after the shared owner settles policy and live authority. */
export function moveWindowsMetadataNoReplaceSync(input: RootMoveCommandInput): void {
  dispatch(snapshot(input));
}

/** Independent admitted parents; preserves the source's observed hardlink count. */
export function moveWindowsFileNoReplaceSync(input: WindowsFileMoveCommandInput): void {
  dispatch(fileSnapshot(input));
}
