import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_PERMISSION_EXEC_TIMEOUT_MS = 10_000;

export async function executePermissionCommand(
  command: string,
  args: string[],
  timeoutMs = DEFAULT_PERMISSION_EXEC_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return (await execFileAsync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    })) as { stdout: string; stderr: string };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "killed" in err &&
      err.killed === true &&
      "signal" in err &&
      err.signal === "SIGKILL"
    ) {
      throw new Error(`Windows permission inspection timed out after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    throw err;
  }
}
