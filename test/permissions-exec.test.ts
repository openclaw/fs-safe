import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PERMISSION_EXEC_TIMEOUT_MS,
  executePermissionCommand,
} from "../src/permission-exec.js";
import { inspectPathPermissions } from "../src/permissions.js";
import { readSecureFile } from "../src/secure-file.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Windows permission command execution", () => {
  it("terminates a wedged child process on a deterministic deadline", async () => {
    const timeoutMs = 100;
    const startedAt = performance.now();

    await expect(
      executePermissionCommand(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], timeoutMs),
    ).rejects.toThrow(`Windows permission inspection timed out after ${timeoutMs}ms`);

    expect(performance.now() - startedAt).toBeLessThan(3_000);
    expect(DEFAULT_PERMISSION_EXEC_TIMEOUT_MS).toBe(30_000);
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

    await expect(
      readSecureFile({
        filePath: target,
        inject: {
          platform: "win32",
          env: { SystemRoot: "C:\\Windows" },
          exec,
        },
      }),
    ).rejects.toMatchObject({ code: "permission-unverified" });
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
