import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import {
  DEFAULT_PERMISSION_EXEC_TIMEOUT_MS,
  executePermissionCommand,
  getPermissionCommandFailure,
  PermissionCommandError,
} from "../src/permission-exec.js";
import { FsSafeError } from "../src/errors.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import { inspectPathPermissions } from "../src/permissions.js";
import { readSecureFile } from "../src/secure-file.js";

const tempDirs: string[] = [];

beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
});

afterEach(async () => {
  __resetFsSafeNativeConfigForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Windows permission command execution", () => {
  it("terminates a wedged child process on a deterministic deadline", async () => {
    const timeoutMs = 100;
    const startedAt = performance.now();

    const execution = executePermissionCommand(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], timeoutMs);
    await expect(execution).rejects.toThrow(`Windows permission inspection timed out after ${timeoutMs}ms`);
    await expect(execution).rejects.toBeInstanceOf(PermissionCommandError);
    await expect(execution).rejects.toMatchObject({
      command: process.execPath,
      durationMs: expect.any(Number),
      timedOut: true,
      exitCode: null,
      signal: "SIGKILL",
      cause: expect.objectContaining({ killed: true, signal: "SIGKILL" }),
    });
    await execution.catch((error: PermissionCommandError) => {
      expect(error.durationMs).toBeGreaterThanOrEqual(timeoutMs);
      expect(Number.isInteger(error.durationMs)).toBe(true);
    });

    expect(performance.now() - startedAt).toBeLessThan(3_000);
    expect(DEFAULT_PERMISSION_EXEC_TIMEOUT_MS).toBe(30_000);
  });

  it("preserves non-timeout child failures without copying stdout into diagnostics", async () => {
    const execution = executePermissionCommand(process.execPath, [
      "-e",
      'process.stdout.write("PRIVATE_CHILD_STDOUT"); process.stderr.write("ACL access denied"); process.exitCode = 23;',
    ]);
    await expect(execution).rejects.toBeInstanceOf(PermissionCommandError);
    await expect(execution).rejects.toMatchObject({
      command: process.execPath,
      timedOut: false,
      exitCode: 23,
      signal: null,
      stderr: "ACL access denied",
      message: expect.stringContaining(`${path.basename(process.execPath)} failed (exit code 23`),
      cause: expect.objectContaining({ code: 23 }),
    });
    await execution.catch((error: PermissionCommandError) => {
      expect(error.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(error.durationMs)).toBe(true);
      const detail = getPermissionCommandFailure(error, "ignored", 0);
      expect(Object.keys(detail!).sort()).toEqual([
        "command", "durationMs", "exitCode", "signal", "stderr", "timedOut",
      ]);
      expect(`${error.message}${JSON.stringify(detail)}`).not.toContain("PRIVATE_CHILD_STDOUT");
    });
  });

  it("escapes control characters in stderr and bounds the excerpt including its marker", async () => {
    const stderr = `\u001b[31mdenied\n${"x".repeat(500)}`;
    const escapedPrefix = "\\u001b[31mdenied\\u000a";
    await expect(executePermissionCommand(process.execPath, [
      "-e", `process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1;`,
    ])).rejects.toMatchObject({
      stderr: `${escapedPrefix}${"x".repeat(399 - escapedPrefix.length)}…`,
      timedOut: false,
    });
  });

  it("wraps spawn errors and leaves plain errors without invented command details", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-permission-spawn-"));
    tempDirs.push(dir);
    const command = path.join(dir, "missing-command");
    await expect(executePermissionCommand(command, [])).rejects.toMatchObject({
      name: "PermissionCommandError", command, timedOut: false,
      exitCode: null, signal: null, stderr: "",
      cause: expect.objectContaining({ code: "ENOENT" }),
    });
    expect(getPermissionCommandFailure(new Error("plain"), command, 10)).toBeUndefined();
    expect(getPermissionCommandFailure(null, command, 10)).toBeUndefined();
  });

  it.each(["structured", "raw"])("preserves a %s owner timeout through a failed secure read", async (kind) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-permission-owner-detail-"));
    tempDirs.push(dir);
    const target = path.join(dir, "secret.json");
    const secret = "SECRET_FILE_CONTENT_MUST_NOT_APPEAR";
    await fs.writeFile(target, secret, { mode: 0o600 });
    const original = Object.assign(new Error("owner query timed out"), {
      killed: true, signal: "SIGKILL", code: null, stderr: "owner inspection stalled\n",
    });
    let commandError: unknown;
    const exec = vi.fn(async (command: string) => {
      commandError = kind === "structured"
        ? new PermissionCommandError(command, 30_125, original)
        : original;
      throw commandError;
    });
    const failure = await readSecureFile({
      filePath: target,
      inject: { platform: "win32", env: { SystemRoot: "C:\\Windows" }, exec },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FsSafeError);
    expect(failure).toMatchObject({
      code: "permission-unverified",
      category: "operational",
      message: expect.stringContaining(kind === "structured"
        ? "Windows permission inspection timed out after 30000ms" : "owner query timed out"),
      details: {
        command: expect.stringContaining("powershell.exe"),
        durationMs: kind === "structured" ? 30_125 : expect.any(Number),
        timedOut: true, exitCode: null, signal: "SIGKILL",
        stderr: "owner inspection stalled\\u000a",
        ownerError: expect.stringContaining("timed out"),
      },
    });
    const error = failure as FsSafeError;
    expect(error.cause).toBe(commandError);
    if (kind === "structured") expect((error.cause as Error).cause).toBe(original);
    expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(secret);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("preserves icacls stderr and exit status after a successful owner query", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-permission-acl-detail-"));
    tempDirs.push(dir);
    const target = path.join(dir, "secret.json");
    const secret = "SECRET_FILE_CONTENT_MUST_NOT_APPEAR";
    await fs.writeFile(target, secret, { mode: 0o600 });
    const original = Object.assign(new Error(`ACL query denied\n${"x".repeat(500)}`), {
      code: 5, signal: null, killed: false,
      stderr: `\u001b[31mACL access denied\n${"x".repeat(500)}`,
      stdout: "PRIVATE_CHILD_STDOUT",
    });
    const exec = vi.fn(async (command: string) => {
      if (command.endsWith("powershell.exe")) {
        return { stdout: JSON.stringify({
          ownerSid: "S-1-5-21-42", currentUserSid: "S-1-5-21-42", remote: false,
        }), stderr: "" };
      }
      throw original;
    });
    const failure = await readSecureFile({
      filePath: target,
      inject: { platform: "win32", env: { SystemRoot: "C:\\Windows" }, exec },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FsSafeError);
    expect(failure).toMatchObject({
      code: "permission-unverified", category: "operational",
      message: expect.stringContaining("Error: ACL query denied\\u000a"),
      details: {
        command: "C:\\Windows\\System32\\icacls.exe",
        durationMs: expect.any(Number), timedOut: false, exitCode: 5, signal: null,
        stderr: expect.stringContaining("\\u001b[31mACL access denied\\u000a"),
      },
    });
    const error = failure as FsSafeError;
    expect(error.cause).toBe(original);
    expect(error.details?.stderr).toHaveLength(400);
    expect(String(error.details?.stderr)).toMatch(/…$/u);
    const reason = error.message.split(": Error: ")[1]!;
    expect(`Error: ${reason}`).toHaveLength(400);
    const diagnostic = `${error.message}${JSON.stringify(error.details)}`;
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain("PRIVATE_CHILD_STDOUT");
    expect(diagnostic).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(exec.mock.calls.map(([command]) => path.win32.basename(command))).toEqual([
      "powershell.exe", "icacls.exe",
    ]);
  });

  it("allows a slow command to finish within its deadline", async () => {
    const delayMs = 250;
    const startedAt = performance.now();

    const result = await executePermissionCommand(
      process.execPath,
      ["-e", `setTimeout(() => process.stdout.write("done"), ${delayMs})`],
      5_000,
    );

    expect(result.stdout).toBe("done");
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(delayMs);
  });

  it("fails closed without starting an ACL query when owner inspection fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-permission-timeout-"));
    tempDirs.push(dir);
    const target = path.join(dir, "secret.json");
    await fs.writeFile(target, "{}", { mode: 0o600 });
    const exec = vi.fn().mockRejectedValue(new Error("owner query timed out"));

    const result = await inspectPathPermissions(target, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      exec,
    });

    expect(result).toMatchObject({
      ok: true,
      source: "unknown",
      ownerError: "Error: owner query timed out",
      error: expect.stringContaining("Windows owner inspection failed"),
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a successful ACL command yields no verifiable entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-permission-empty-acl-"));
    tempDirs.push(dir);
    const target = path.join(dir, "secret.json");
    await fs.writeFile(target, "{}", { mode: 0o600 });
    const exec = vi.fn(async (command: string) => {
      if (command.toLowerCase().endsWith("powershell.exe")) {
        return {
          stdout: JSON.stringify({
            ownerSid: "S-1-5-21-42",
            currentUserSid: "S-1-5-21-42",
            principalSids: [],
            principalTranslationFailed: false,
            remote: false,
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      inspectPathPermissions(target, {
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        exec,
      }),
    ).resolves.toMatchObject({
      ok: true,
      source: "unknown",
      error: expect.stringContaining("could not be verified"),
    });

    await expectFsSafeError(readSecureFile({
        filePath: target,
        inject: {
          platform: "win32",
          env: { SystemRoot: "C:\\Windows" },
          exec,
        },
      }), "permission-unverified");
  });

  it("inspects permissions once for one secure read", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-permission-count-"));
    tempDirs.push(dir);
    const target = path.join(dir, "secret.json");
    await fs.writeFile(target, "{}", { mode: 0o600 });
    const exec = vi.fn(async (command: string, args: string[]) => {
      if (command.toLowerCase().endsWith("powershell.exe")) {
        return {
          stdout: JSON.stringify({
            ownerSid: "S-1-5-21-42",
            currentUserSid: "S-1-5-21-42",
            principalSids: [{ name: "S-1-5-21-42", sid: "S-1-5-21-42" }],
            principalTranslationFailed: false,
            remote: false,
          }),
          stderr: "",
        };
      }
      return { stdout: `${args[0]} *S-1-5-21-42:(F)\n`, stderr: "" };
    });

    const result = await readSecureFile({
      filePath: target,
      inject: {
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        exec,
      },
    });

    expect(result.permissions).toMatchObject({ source: "windows-acl", ownerTrusted: true });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.map(([command]) => path.win32.basename(command))).toEqual([
      "powershell.exe",
      "icacls.exe",
    ]);
  });
});
