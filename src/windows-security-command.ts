import { spawn, spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { FsSafeError } from "./errors.js";
import type { NativeWindowsDescriptorSecurityFacts, NativeWindowsSecurityFacts } from "./native-binding.js";
import { DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, PermissionCommandError } from "./permission-exec.js";
import { resolveWindowsSystemCommand } from "./windows-command.js";
import { WINDOWS_SECURITY_SOURCE } from "./windows-security-source.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const SID = /^s-\d+-\d+(?:-\d+)+$/;
const WORLD = new Set(["s-1-1-0", "s-1-5-11", "s-1-5-32-545", "s-1-5-7", "s-1-5-32-546", "s-1-5-4", "s-1-5-2"]);
let encodedSource: string | undefined;

function command(operation: "path" | "descriptor" | "create", targetPath = "") {
  encodedSource ??= gzipSync(WINDOWS_SECURITY_SOURCE).toString("base64");
  // Compress the fixed bridge so -EncodedCommand stays below Windows' command
  // line limit. No script file or user-controlled PowerShell expression is used.
  const source = [
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
    `$b=[Convert]::FromBase64String('${encodedSource}')`,
    "$m=[IO.MemoryStream]::new($b,$false)",
    "$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress)",
    "$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8)",
    "try{Add-Type -TypeDefinition $r.ReadToEnd()}finally{$r.Dispose();$g.Dispose();$m.Dispose()}",
    "$p=[Environment]::GetEnvironmentVariable('FS_SAFE_WINDOWS_SECURITY_PATH')",
    `[FsSafeWindowsBridge]::Execute('${operation}',$p)|ConvertTo-Json -Depth 8 -Compress`,
  ].join(";");
  return {
    file: resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")],
    // Preserve Windows UTF-16 spelling and leave long paths out of the bounded
    // command line. This overrides any inherited value only in this child.
    env: { ...process.env, FS_SAFE_WINDOWS_SECURITY_PATH: targetPath },
  };
}

function unverified(message: string, cause?: unknown): never {
  throw new FsSafeError("permission-unverified", message, cause === undefined ? {} : { cause });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function parseReply(stdout: string): unknown {
  let response: unknown;
  try { response = JSON.parse(stdout.trim()); } catch (cause) {
    unverified("Windows security command returned invalid data", cause);
  }
  if (!record(response) || typeof response.ok !== "boolean") {
    unverified("Windows security command returned an incomplete response");
  }
  if (!response.ok) {
    const codes = new Set(["EACCES", "EEXIST", "ENOENT", "ENOTSUP", "EIO", "EBADF", "ELOOP", "ENOTDIR", "EINVAL"]);
    if (typeof response.code !== "string" || !codes.has(response.code) || typeof response.message !== "string") {
      unverified("Windows security command returned an invalid failure");
    }
    throw Object.assign(new Error(response.message), { code: response.code });
  }
  return response.result;
}

function parseSecurity(value: unknown): NativeWindowsSecurityFacts {
  if (!record(value) || typeof value.ownerSid !== "string" || !SID.test(value.ownerSid) ||
      typeof value.currentUserSid !== "string" || !SID.test(value.currentUserSid) ||
      typeof value.daclPresent !== "boolean" || typeof value.daclProtected !== "boolean" ||
      typeof value.isLocal !== "boolean" || typeof value.aceListComplete !== "boolean" ||
      !Array.isArray(value.unsupportedAceTypes) || !value.unsupportedAceTypes.every(uint32) || !Array.isArray(value.aces)) {
    unverified("Windows security command returned malformed descriptor facts");
  }
  const aces: NativeWindowsSecurityFacts["aces"] = [];
  const flagBits = [
    ["objectInherit", 1], ["containerInherit", 2], ["noPropagateInherit", 4], ["inheritOnly", 8],
    ["inherited", 16], ["successfulAccess", 64], ["failedAccess", 128],
  ] as const;
  for (const ace of value.aces) {
    if (!record(ace) || typeof ace.sid !== "string" || !SID.test(ace.sid) || !uint32(ace.mask) ||
        (ace.aceType !== "allow" && ace.aceType !== "deny") || !record(ace.flags) ||
        !uint32(ace.flags.raw) || (ace.flags.raw & ~0xdf) !== 0) {
      unverified("Windows security command returned malformed access rules");
    }
    const flags = ace.flags;
    const raw = flags.raw as number;
    if (!flagBits.every(([name, bit]) => typeof flags[name] === "boolean" && flags[name] === ((raw & bit) !== 0))) {
      unverified("Windows security command returned inconsistent access-rule flags");
    }
    aces.push(ace as unknown as NativeWindowsSecurityFacts["aces"][number]);
  }
  if ((!value.daclPresent && aces.length !== 0) ||
      (value.aceListComplete && value.unsupportedAceTypes.length !== 0)) {
    unverified("Windows security command returned inconsistent DACL facts");
  }
  const ownerClass = value.ownerSid === value.currentUserSid ? "current-user"
    : value.ownerSid === "s-1-5-18" ? "system" : value.ownerSid === "s-1-5-32-544" ? "administrators" : "foreign";
  let worldReadable = !value.daclPresent;
  let worldWritable = !value.daclPresent;
  let groupReadable = false;
  let groupWritable = false;
  const trusted = new Set([value.currentUserSid, "s-1-5-18", "s-1-5-32-544"]);
  for (const ace of aces) {
    if (ace.aceType === "deny" || ace.flags.inheritOnly || trusted.has(ace.sid)) continue;
    const read = (ace.mask & 0x9000_0089) !== 0;
    const write = (ace.mask & 0x500d_0156) !== 0;
    if (WORLD.has(ace.sid)) { worldReadable ||= read; worldWritable ||= write; }
    else { groupReadable ||= read; groupWritable ||= write; }
  }
  return {
    ownerSid: value.ownerSid, currentUserSid: value.currentUserSid, ownerClass,
    daclPresent: value.daclPresent, isLocal: value.isLocal, aceListComplete: value.aceListComplete,
    unsupportedAceTypes: value.unsupportedAceTypes, aces,
    fallbackRequired: !value.isLocal || !value.aceListComplete,
    worldReadable, worldWritable, groupReadable, groupWritable,
  };
}

function executeSync(operation: "path", targetPath: string): unknown {
  const { file, args, env } = command(operation, targetPath);
  const startedAt = performance.now();
  const result = spawnSync(file, args, {
    encoding: "utf8", windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"],
    timeout: DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0) {
    throw new PermissionCommandError(file, performance.now() - startedAt, {
      cause: result.error, code: result.status,
      signal: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ? "SIGKILL" : result.signal,
      stderr: result.stderr,
      killed: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    });
  }
  return parseReply(result.stdout);
}

async function execute(operation: "descriptor" | "create", params: { fd?: number; targetPath?: string }): Promise<unknown> {
  const { file, args, env } = command(operation, params.targetPath);
  const startedAt = performance.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, env, stdio: [params.fd ?? "ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let failure: unknown;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, DEFAULT_PERMISSION_EXEC_TIMEOUT_MS);
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_OUTPUT_BYTES) chunks.push(chunk);
      else {
        failure ??= new Error("Windows security command exceeded its output budget");
        child.kill("SIGKILL");
      }
    };
    child.stdout!.on("data", collect(output));
    child.stderr!.on("data", collect(errors));
    child.once("error", error => { failure = error; });
    // Join process exit and drain both pipes before allowing the caller's fd to close.
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (failure || timedOut || code !== 0) {
        reject(new PermissionCommandError(file, performance.now() - startedAt, {
          cause: failure, code, signal: timedOut ? "SIGKILL" : signal, killed: timedOut, stderr: Buffer.concat(errors),
        }));
      } else {
        try { resolve(parseReply(Buffer.concat(output).toString("utf8"))); } catch (error) { reject(error); }
      }
    });
  });
}

export function readWindowsSecurityFactsCommand(targetPath: string): NativeWindowsSecurityFacts {
  return parseSecurity(executeSync("path", targetPath));
}

export async function inspectWindowsDescriptorCommand(fd: number): Promise<NativeWindowsDescriptorSecurityFacts> {
  if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fff_ffff) {
    unverified("Windows security inspection requires a valid descriptor");
  }
  const response = await execute("descriptor", { fd });
  if (!record(response) || typeof response.identity !== "string") {
    unverified("Windows security command returned incomplete handle facts");
  }
  return { identity: response.identity, security: parseSecurity(response.security) };
}

export async function createPrivateWindowsDirectoryCommand(targetPath: string): Promise<void> {
  const response = await execute("create", { targetPath });
  if (!record(response) || response.created !== true) {
    unverified("Windows security command did not verify private-directory creation");
  }
}
