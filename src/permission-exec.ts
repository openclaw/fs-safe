import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { formatErrorDetail } from "./error-detail.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_PERMISSION_EXEC_TIMEOUT_MS = 30_000;

export type PermissionCommandFailure = {
  command: string;
  durationMs: number;
  timedOut: boolean;
  exitCode: number | null;
  signal: string | null;
  stderr: string;
};

export function formatPermissionErrorDetail(value: string): string {
  const formatted = formatErrorDetail(value);
  return formatted.length > 400 ? `${formatted.slice(0, 399)}…` : formatted;
}

function commandFailureFields(error: unknown) {
  const fields = error && typeof error === "object" ? error : {};
  return {
    timedOut: "killed" in fields && fields.killed === true &&
      "signal" in fields && fields.signal === "SIGKILL",
    exitCode: "code" in fields && typeof fields.code === "number" ? fields.code : null,
    signal: "signal" in fields && typeof fields.signal === "string" ? fields.signal : null,
    stderr: formatPermissionErrorDetail(
      "stderr" in fields && (typeof fields.stderr === "string" || Buffer.isBuffer(fields.stderr))
        ? fields.stderr.toString() : "",
    ),
  };
}

export class PermissionCommandError extends Error implements PermissionCommandFailure {
  readonly command: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;

  constructor(
    command: string,
    durationMs: number,
    cause: unknown,
    timeoutMs = DEFAULT_PERMISSION_EXEC_TIMEOUT_MS,
  ) {
    const fields = commandFailureFields(cause);
    super(fields.timedOut
      ? `Windows permission inspection timed out after ${timeoutMs}ms`
      : `Windows permission command ${formatPermissionErrorDetail(path.win32.basename(command))} failed (exit code ${fields.exitCode}, signal ${formatPermissionErrorDetail(fields.signal ?? "none")})`,
    { cause });
    this.name = "PermissionCommandError";
    this.command = command;
    this.durationMs = Math.round(durationMs);
    this.timedOut = fields.timedOut;
    this.exitCode = fields.exitCode;
    this.signal = fields.signal;
    this.stderr = fields.stderr;
  }
}

export function getPermissionCommandFailure(
  error: unknown,
  command: string,
  durationMs: number,
): PermissionCommandFailure | undefined {
  if (error instanceof PermissionCommandError) {
    return {
      command: error.command,
      durationMs: error.durationMs,
      timedOut: error.timedOut,
      exitCode: error.exitCode,
      signal: error.signal,
      stderr: error.stderr,
    };
  }
  if (!error || typeof error !== "object" ||
    !("code" in error || "signal" in error || "killed" in error || "stderr" in error)) {
    return undefined;
  }
  return { command, durationMs: Math.round(durationMs), ...commandFailureFields(error) };
}

export async function executePermissionCommand(
  command: string,
  args: string[],
  timeoutMs = DEFAULT_PERMISSION_EXEC_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  const startedAt = performance.now();
  try {
    return (await execFileAsync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    })) as { stdout: string; stderr: string };
  } catch (err) {
    throw new PermissionCommandError(command, performance.now() - startedAt, err, timeoutMs);
  }
}
