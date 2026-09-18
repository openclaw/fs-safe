import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FsSafeError } from "./errors.js";
import type { NativeWindowsDescriptorSecurityFacts, NativeWindowsSecurityFacts } from "./native-binding.js";
import { DEFAULT_PERMISSION_EXEC_TIMEOUT_MS, PermissionCommandError } from "./permission-exec.js";
import { resolveWindowsSystemCommand } from "./windows-command.js";
import { parseWindowsSecurityCommandFacts } from "./windows-security-facts.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 1_000;

function command(operation: "path" | "descriptor" | "create", targetPath = "") {
  // Preserve native EINVAL before child-process environment validation runs.
  if (targetPath.includes("\0")) {
    throw Object.assign(new Error("Windows path contains a NUL byte"), { code: "EINVAL" });
  }
  const script = fileURLToPath(new URL("./windows-security-bridge.ps1", import.meta.url));
  return {
    file: resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, "-Operation", operation],
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

function parseReply(stdout: string): unknown {
  let response: unknown;
  try { response = JSON.parse(stdout.trim()); } catch (cause) {
    unverified("Windows security command returned invalid data", cause);
  }
  if (!record(response) || typeof response.ok !== "boolean") {
    unverified("Windows security command returned an incomplete response");
  }
  if (!response.ok) {
    const codes = new Set(["EACCES", "EPERM", "EEXIST", "ENOENT", "ENOTSUP", "EIO", "EBADF", "ELOOP", "ENOTDIR", "EINVAL", "ENOSPC", "EBUSY"]);
    if (typeof response.code !== "string" || !codes.has(response.code) || typeof response.message !== "string") {
      unverified("Windows security command returned an invalid failure");
    }
    throw Object.assign(new Error(response.message), { code: response.code });
  }
  return response.result;
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

type CommandFailureReceipt = {
  cause: unknown;
  pid: number | null;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: Buffer;
  processExitConfirmed: boolean;
  outputClosed: boolean;
  terminationSignalSent?: boolean;
  terminationError?: unknown;
  cleanupErrors: unknown[];
  creationOutcome?: "unconfirmed";
};

class WindowsSecurityCommandError extends PermissionCommandError {
  override readonly timedOut: boolean;

  constructor(file: string, durationMs: number, receipt: CommandFailureReceipt, timedOut: boolean) {
    super(file, durationMs, receipt);
    this.timedOut = timedOut;
    if (timedOut) this.message = `Windows permission inspection timed out after ${DEFAULT_PERMISSION_EXEC_TIMEOUT_MS}ms`;
    if (!receipt.processExitConfirmed) this.message += "; process exit was not confirmed";
    else if (!receipt.outputClosed) this.message += "; command output did not close";
    if (receipt.creationOutcome) this.message += "; private-directory creation outcome is unconfirmed";
  }
}

function ignoreLateError(): void {}

async function execute(operation: "descriptor" | "create", params: { fd?: number; targetPath?: string }): Promise<unknown> {
  const { file, args, env } = command(operation, params.targetPath);
  const startedAt = performance.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, env, stdio: [params.fd ?? "ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let failure: unknown;
    let failed = false;
    let timedOut = false;
    let stopping = false;
    let settled = false;
    let processExitConfirmed = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let terminationSignalSent: boolean | undefined;
    let terminationError: unknown;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let missingPipes: ReturnType<typeof setImmediate> | undefined;
    const deadlineError = () => new Error("Windows security command exceeded its inspection deadline");
    const timeout = setTimeout(() => {
      timedOut = true;
      fail(deadlineError());
    }, DEFAULT_PERMISSION_EXEC_TIMEOUT_MS);

    const finish = (outputClosed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(grace);
      clearImmediate(missingPipes);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.removeListener("error", onChildError);
      child.on("error", ignoreLateError);
      const cleanupErrors: unknown[] = [];
      for (const [stream, collect] of [[child.stdout, collectOutput], [child.stderr, collectErrors]] as const) {
        if (!stream) continue;
        stream.removeListener("data", collect);
        stream.removeListener("error", fail);
        stream.on("error", ignoreLateError);
        if (!outputClosed) {
          try { stream.destroy(); } catch (error) { cleanupErrors.push(error); }
        }
      }
      if (!outputClosed && !processExitConfirmed) {
        try { child.unref(); } catch (error) { cleanupErrors.push(error); }
      }
      if (failed || exitCode !== 0 || !outputClosed) {
        reject(new WindowsSecurityCommandError(file, performance.now() - startedAt, {
          cause: failure, pid: child.pid ?? null, code: exitCode, signal: exitSignal, stderr: Buffer.concat(errors),
          processExitConfirmed, outputClosed, terminationSignalSent, terminationError, cleanupErrors,
          ...(operation === "create" ? { creationOutcome: "unconfirmed" } as const : {}),
        }, timedOut));
      } else {
        try { resolve(parseReply(Buffer.concat(output).toString("utf8"))); } catch (error) { reject(error); }
      }
      output.length = 0;
      errors.length = 0;
    };
    const fail = (error: unknown) => {
      if (settled) return;
      if (!failed) { failed = true; failure = error; }
      if (stopping) return;
      stopping = true;
      clearTimeout(timeout);
      // kill() can synchronously emit error, throw, or return false. None proves exit.
      grace = setTimeout(() => finish(false), TERMINATION_GRACE_MS);
      if (!processExitConfirmed) {
        try { terminationSignalSent = child.kill("SIGKILL"); } catch (error) { terminationError ??= error; }
      }
    };
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (failed || settled) return;
      bytes += chunk.length;
      if (bytes <= MAX_OUTPUT_BYTES) chunks.push(chunk);
      else fail(new Error("Windows security command exceeded its output budget"));
    };
    const collectOutput = collect(output);
    const collectErrors = collect(errors);
    const onChildError = (error: Error) => {
      if (settled) return;
      if (stopping) terminationError ??= error;
      else fail(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      processExitConfirmed = true;
      exitCode = code;
      exitSignal = signal;
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      onExit(code, signal);
      if (!failed && performance.now() - startedAt >= DEFAULT_PERMISSION_EXEC_TIMEOUT_MS) {
        timedOut = true;
        failed = true;
        failure = deadlineError();
      }
      finish(true);
    };
    child.on("error", onChildError);
    child.once("exit", onExit);
    // Success still joins exit and both pipes. Failure releases only owned endpoints
    // after grace; the child inherited its own HANDLE, independent of the caller fd.
    child.once("close", onClose);
    child.stdout?.on("error", fail);
    child.stderr?.on("error", fail);
    child.stdout?.on("data", collectOutput);
    child.stderr?.on("data", collectErrors);
    if (!child.stdout || !child.stderr) {
      // Node reports spawn errors on nextTick, which can follow the current microtask.
      missingPipes = setImmediate(() => { if (!failed && !settled) fail(new Error("Windows security command output pipes are unavailable")); });
    }
  });
}

export function readWindowsSecurityFactsCommand(targetPath: string): NativeWindowsSecurityFacts {
  return parseWindowsSecurityCommandFacts(executeSync("path", targetPath));
}

export async function inspectWindowsDescriptorCommand(fd: number): Promise<NativeWindowsDescriptorSecurityFacts> {
  if (!Number.isInteger(fd) || fd < 0 || fd > 0x7fff_ffff) {
    unverified("Windows security inspection requires a valid descriptor");
  }
  const response = await execute("descriptor", { fd });
  if (!record(response) || typeof response.identity !== "string") {
    unverified("Windows security command returned incomplete handle facts");
  }
  return { identity: response.identity, security: parseWindowsSecurityCommandFacts(response.security) };
}

export async function createPrivateWindowsDirectoryCommand(targetPath: string): Promise<void> {
  const response = await execute("create", { targetPath });
  if (!record(response) || response.created !== true) {
    unverified("Windows security command did not verify private-directory creation");
  }
}
