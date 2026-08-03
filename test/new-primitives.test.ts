import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, itWin32 } from "./helpers/vitest.js";
import {
  appendRegularFile,
  appendRegularFileSync,
  readRegularFile,
  readRegularFileSync,
  resolveRegularFileAppendFlags,
  statRegularFile,
} from "../src/regular-file.js";
import {
  tempWorkspace,
  tempWorkspaceSync,
  withTempWorkspace,
  withTempWorkspaceSync,
} from "../src/private-temp-workspace.js";
import {
  assertNoSymlinkParents,
  assertNoSymlinkParentsSync,
} from "../src/symlink-parents.js";
import { pathScope } from "../src/root-paths.js";
import { replaceFileAtomic, replaceFileAtomicSync } from "../src/replace-file.js";
import { movePathWithCopyFallback } from "../src/move-path.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { acquireFileLock, createFileLockManager, withFileLock } from "../src/file-lock.js";
import { fileStore, fileStoreSync } from "../src/file-store.js";
import { jsonStore } from "../src/json-store.js";
import {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  formatPermissionDetail,
  formatPermissionRemediation,
  formatWindowsAclSummary,
  inspectPathPermissions,
  inspectWindowsAcl,
  modeBits,
  parseIcaclsOutput,
  resolveWindowsUserPrincipal,
  summarizeWindowsAcl,
} from "../src/permissions.js";
import { readSecureFile } from "../src/secure-file.js";
import {
  walkDirectory,
  walkDirectorySync,
  type WalkDirectoryResult,
} from "../src/walk.js";

let root: string;
const execFileAsync = promisify(execFile);

async function secureWindowsTestFile(filePath: string): Promise<void> {
  const username = os.userInfo().username;
  const commandEnv = { SystemRoot: process.env.SystemRoot };
  const userInfo = () => ({ username });
  const principal = resolveWindowsUserPrincipal(commandEnv, userInfo);
  const reset = createIcaclsResetCommand(filePath, {
    isDir: false,
    env: commandEnv,
    userInfo,
  });
  if (!principal || !reset) {
    throw new Error("Windows test principal could not be resolved");
  }
  await execFileAsync(reset.command, [filePath, "/setowner", principal], { windowsHide: true });
  await execFileAsync(reset.command, reset.args, { windowsHide: true });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-new-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("private temp workspaces", () => {
  it("writes private files and removes the workspace", async () => {
    let workspaceDir = "";
    const content = await withTempWorkspace({ rootDir: root, prefix: "work-" }, async (tmp) => {
      workspaceDir = tmp.dir;
      const filePath = await tmp.write("input.txt", "hello");
      expect(await fs.readFile(filePath, "utf8")).toBe("hello");
      return await tmp.read("input.txt");
    });

    expect(content.toString("utf8")).toBe("hello");
    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects path-like file names", async () => {
    const tmp = await tempWorkspace({ rootDir: root, prefix: "work-" });
    try {
      await expect(tmp.write("../escape.txt", "nope")).rejects.toThrow(/Invalid/);
    } finally {
      await tmp.cleanup();
    }
  });

  it("supports sync temp workspaces", async () => {
    let workspaceDir = "";
    const result = withTempWorkspaceSync({ rootDir: root, prefix: "sync-" }, (tmp) => {
      workspaceDir = tmp.dir;
      const filePath = tmp.write("input.txt", "hello");
      expect(tmp.read("input.txt").toString("utf8")).toBe("hello");
      return filePath;
    });
    expect(path.basename(result)).toBe("input.txt");
    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });

    const tmp = tempWorkspaceSync({ rootDir: root, prefix: "sync-" });
    try {
      expect(tmp.write("again.txt", "ok")).toContain("again.txt");
    } finally {
      tmp.cleanup();
    }
  });

  it("supports the compact tempWorkspace factory and await using cleanup", async () => {
    let workspaceDir = "";
    {
      await using tmp = await tempWorkspace({ rootDir: root, prefix: "compact-" });
      workspaceDir = tmp.dir;
      const filePath = await tmp.write("input.txt", "hello");
      expect(filePath).toBe(tmp.path("input.txt"));
      expect(tmp.path("input.txt")).toBe(filePath);
      await tmp.store.json<{ ok: boolean }>("state.json").write({ ok: true });
      await expect(tmp.store.readJson("state.json")).resolves.toEqual({ ok: true });
    }

    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes JSON and copies files through temp workspace helpers", async () => {
    await using tmp = await tempWorkspace({ rootDir: root, prefix: "helpers-" });
    const source = path.join(root, "source.txt");
    await fs.writeFile(source, "copied", "utf8");

    expect(await fs.readFile(await tmp.writeText("text.txt", "hello"), "utf8")).toBe("hello");
    expect(JSON.parse(await fs.readFile(await tmp.writeJson("state.json", { ok: true }), "utf8")))
      .toEqual({ ok: true });
    expect(await fs.readFile(await tmp.copyIn("copy.txt", source), "utf8")).toBe("copied");
  });
});

describe("file store", () => {
  it.skipIf(process.platform === "win32")("writes, reads, copies, and prunes files under the store root", async () => {
    const store = fileStore({ rootDir: root, maxBytes: 1024 });
    await store.write("media/a.txt", "hello");
    await expect(store.readBytes("media/a.txt")).resolves.toEqual(Buffer.from("hello"));
    await expect(store.readText("media/a.txt")).resolves.toBe("hello");
    await store.writeJson("media/state.json", { ok: true });
    await expect(store.readJson("media/state.json")).resolves.toEqual({ ok: true });

    const source = path.join(root, "source.bin");
    await fs.writeFile(source, "source", "utf8");
    await store.copyIn("media/b.txt", source);
    await expect(store.readBytes("media/b.txt")).resolves.toEqual(Buffer.from("source"));

    await fs.utimes(store.path("media/a.txt"), new Date(0), new Date(0));
    await store.pruneExpired({ ttlMs: 1, recursive: true, pruneEmptyDirs: true });
    await expect(store.exists("media/a.txt")).resolves.toBe(false);
  });

  it("rejects escaped paths and size limit violations", async () => {
    const store = fileStore({ rootDir: root, maxBytes: 3 });
    await expect(store.write("../escape.txt", "nope")).rejects.toThrow();
    await expectFsSafeError(store.write("too-large.txt", "four"), "too-large");
  });
});

describe("json store", () => {
  it("reads fallback, writes atomically, and updates under a lock", async () => {
    const filePath = path.join(root, "state", "store.json");
    const store = fileStore({ rootDir: path.dirname(filePath), private: true }).json<{
      count: number;
    }>(path.basename(filePath), {
      lock: true,
    });

    await expect(store.read()).resolves.toBeUndefined();
    await expect(store.readOr({ count: 10 })).resolves.toEqual({ count: 10 });
    await expect(store.readRequired()).rejects.toMatchObject({ code: "not-found" });
    await store.updateOr({ count: 0 }, (current) => ({ count: current.count + 1 }));
    await expect(store.read()).resolves.toEqual({ count: 1 });
    await expect(store.readRequired()).resolves.toEqual({ count: 1 });

    const strictStore = jsonStore<{ count: number }>({ filePath: path.join(root, "missing.json") });
    await expect(strictStore.read()).resolves.toBeUndefined();
    await expect(strictStore.readOr({ count: 2 })).resolves.toEqual({ count: 2 });
  });
});

describe("secure file reads", () => {
  itPosix("reads from a validated file handle", async () => {
    const filePath = path.join(root, "secret.json");
    await fs.writeFile(filePath, '{"token":"ok"}', { mode: 0o600 });
    await fs.chmod(filePath, 0o600).catch(() => undefined);

    const result = await readSecureFile({
      filePath,
      label: "test secret",
      io: { maxBytes: 1024 },
    });

    expect(result.buffer.toString("utf8")).toBe('{"token":"ok"}');
    expect(result.realPath).toBe(await fs.realpath(filePath));
  });

  itWin32("reads from a validated Windows ACL and owner", async () => {
    const filePath = path.join(root, "secret.json");
    await fs.writeFile(filePath, '{"token":"ok"}', { mode: 0o600 });
    await secureWindowsTestFile(filePath);

    const result = await readSecureFile({
      filePath,
      label: "test secret",
      io: { maxBytes: 1024 },
    });

    expect(result.buffer.toString("utf8")).toBe('{"token":"ok"}');
    expect(result.permissions).toMatchObject({
      source: "windows-acl",
      ownerTrusted: true,
    });
  }, 60_000);

  itWin32("treats an extended-length local Windows path as local", async () => {
    const filePath = path.join(root, "extended-secret.json");
    await fs.writeFile(filePath, '{"token":"ok"}', { mode: 0o600 });
    await secureWindowsTestFile(filePath);
    const extendedPath = `\\\\?\\${path.resolve(filePath)}`;

    const result = await readSecureFile({
      filePath: extendedPath,
      label: "extended-path secret",
      io: { maxBytes: 1024 },
    });

    expect(result.buffer.toString("utf8")).toBe('{"token":"ok"}');
    expect(result.permissions).toMatchObject({
      source: "windows-acl",
      ownerTrusted: true,
    });
  }, 60_000);

  it("rejects symlinks and files outside trusted dirs", async () => {
    const trusted = path.join(root, "trusted");
    const outside = path.join(root, "outside");
    await fs.mkdir(trusted);
    await fs.mkdir(outside);
    const trustedFile = path.join(trusted, "secret.txt");
    const outsideFile = path.join(outside, "secret.txt");
    const link = path.join(trusted, "link.txt");
    await fs.writeFile(trustedFile, "ok", { mode: 0o600 });
    await fs.writeFile(outsideFile, "no", { mode: 0o600 });
    await fs.symlink(outsideFile, link);

    await expect(readSecureFile({ filePath: link })).rejects.toMatchObject({ code: "symlink" });
    await expectFsSafeError(readSecureFile({ filePath: outsideFile, trust: { trustedDirs: [trusted] } }), "outside-workspace");
  });

  it("rejects network paths unless explicitly trusted", async () => {
    await expectFsSafeError(readSecureFile({ filePath: String.raw`\\server\share\secret.txt` }), "invalid-path");
  });

  itPosix("rejects overly broad POSIX permissions", async () => {
    const filePath = path.join(root, "too-open.txt");
    await fs.writeFile(filePath, "secret", { mode: 0o644 });
    await fs.chmod(filePath, 0o644);

    await expectFsSafeError(readSecureFile({ filePath }), "insecure-permissions");
  });

  it("covers symlink, directory, size, and trusted-dir secure read branches", async () => {
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    const trusted = path.join(root, "trusted");
    const outsideTrusted = path.join(root, "outside-trusted");
    await fs.writeFile(target, "secret", { mode: 0o600 });
    await fs.symlink(target, link);
    await fs.mkdir(trusted);
    await fs.mkdir(outsideTrusted);

    await expectFsSafeError(readSecureFile({ filePath: "relative.txt" }), "invalid-path");
    await expect(readSecureFile({ filePath: root })).rejects.toMatchObject({ code: "not-file" });
    await expectFsSafeError(readSecureFile({
        filePath: link,
        trust: { allowSymlink: true, trustedDirs: [outsideTrusted] },
        permissions: { allowInsecure: true },
      }), "outside-workspace");

    const result = await readSecureFile({
      filePath: link,
      trust: { allowSymlink: true, trustedDirs: [root] },
      permissions: { allowInsecure: true },
      io: { maxBytes: 100, timeoutMs: 1000 },
    });
    expect(result.buffer.toString("utf8")).toBe("secret");

    await expectFsSafeError(readSecureFile({
        filePath: target,
        permissions: { allowInsecure: true },
        io: { maxBytes: 2 },
      }), "too-large");
  });

  it("uses Windows ACL permission checks for secure reads when requested", async () => {
    const filePath = path.join(root, "windows-secret.txt");
    await fs.writeFile(filePath, "secret", { mode: 0o600 });
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          ownerSid: "S-1-5-21-42",
          currentUserSid: "S-1-5-21-42",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "*S-1-5-18:(F)\n", stderr: "" });

    const result = await readSecureFile({
      filePath,
      inject: { platform: "win32", exec },
      permissions: { allowReadableByOthers: true },
    });
    expect(result.buffer.toString("utf8")).toBe("secret");
    expect(result.permissions?.source).toBe("windows-acl");

    const unsafeExec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          ownerSid: "S-1-5-21-42",
          currentUserSid: "S-1-5-21-42",
          principalSids: [{ name: "Everyone", sid: "S-1-1-0" }],
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "Everyone:(R)\n", stderr: "" });
    await expectFsSafeError(readSecureFile({
        filePath,
        inject: { platform: "win32", exec: unsafeExec },
      }), "insecure-permissions");

    const foreignOwnerExec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          ownerSid: "S-1-5-21-999",
          currentUserSid: "S-1-5-21-42",
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "*S-1-5-21-999:(R)\n", stderr: "" });
    await expectFsSafeError(readSecureFile({
        filePath,
        inject: { platform: "win32", exec: foreignOwnerExec },
        permissions: { allowReadableByOthers: true },
      }), "not-owned");

    const failedExec = vi.fn().mockRejectedValue(new Error("icacls failed"));
    await expectFsSafeError(readSecureFile({
        filePath,
        inject: { platform: "win32", exec: failedExec },
      }), "permission-unverified");
  });

  it("parses icacls output into ACL entries", () => {
    const entries = parseIcaclsOutput(
      String.raw`C:\Users\me\secret.txt *S-1-5-18:(F)
                                *S-1-1-0:(R)`,
      String.raw`C:\Users\me\secret.txt`,
    );

    expect(entries).toMatchObject([
      { principal: "*S-1-5-18", canWrite: true },
      { principal: "*S-1-1-0", canRead: true },
    ]);
  });

  it("resolves Windows system commands from trusted absolute roots", async () => {
    vi.stubEnv("SystemRoot", "D:\\Windows");
    const exec = vi.fn().mockResolvedValue({
      stdout: String.raw`C:\Users\me\secret.txt *S-1-5-18:(F)`,
      stderr: "",
    });

    const result = await inspectWindowsAcl(String.raw`C:\Users\me\secret.txt`, { exec });
    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith("D:\\Windows\\System32\\icacls.exe", [
      String.raw`C:\Users\me\secret.txt`,
    ]);

    const fallbackExec = vi.fn().mockResolvedValue({
      stdout: String.raw`C:\Users\me\secret.txt *S-1-5-18:(F)`,
      stderr: "",
    });
    await inspectWindowsAcl(String.raw`C:\Users\me\secret.txt`, {
      exec: fallbackExec,
      env: { SystemRoot: ".\\fake-root", WINDIR: "E:\\Windows" },
    });
    expect(fallbackExec).toHaveBeenCalledWith("E:\\Windows\\System32\\icacls.exe", [
      String.raw`C:\Users\me\secret.txt`,
    ]);

    const command = createIcaclsResetCommand(String.raw`C:\Users\me\secret.txt`, {
      isDir: false,
      env: { systemroot: ".\\fake-root", username: "me" },
      userInfo: () => ({ username: "me" }),
    });
    expect(command?.command).toBe("C:\\Windows\\System32\\icacls.exe");

    const trailingSeparatorsExec = vi.fn().mockResolvedValue({
      stdout: String.raw`C:\Users\me\secret.txt *S-1-5-18:(F)`,
      stderr: "",
    });
    await inspectWindowsAcl(String.raw`C:\Users\me\secret.txt`, {
      exec: trailingSeparatorsExec,
      env: { SystemRoot: `D:\\Windows${"/".repeat(10_000)}` },
    });
    expect(trailingSeparatorsExec).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\icacls.exe",
      [String.raw`C:\Users\me\secret.txt`],
    );
  });

  it("covers permission formatting and ACL classification helpers", async () => {
    const missing = await inspectPathPermissions(path.join(root, "missing.txt"));
    expect(missing.ok).toBe(false);

    const target = path.join(root, "acl-target.txt");
    const link = path.join(root, "acl-link.txt");
    await fs.writeFile(target, "ok", { mode: 0o640 });
    await fs.symlink(target, link);
    const posix = await inspectPathPermissions(link, { platform: "linux" });
    expect(posix.isSymlink).toBe(true);
    expect(formatPermissionDetail(target, posix)).toContain("mode=");
    expect(
      formatPermissionRemediation({
        targetPath: "/tmp/acl-target.txt",
        perms: posix,
        isDir: false,
        posixMode: 0o600,
      }),
    ).toBe("chmod 600 /tmp/acl-target.txt");

    const entries = parseIcaclsOutput(
      [
        `"C:\\Secrets\\token.txt" DOMAIN\\me:(F)`,
        "Everyone:(R)",
        "BUILTIN\\Users:(M)",
        "*S-1-5-21-123:(R)",
        "Denied:(DENY)(F)",
        "Successfully processed 1 files; Failed processing 0 files",
      ].join("\n"),
      String.raw`C:\Secrets\token.txt`,
    );
    const summary = summarizeWindowsAcl(entries, {
      USERDOMAIN: "DOMAIN",
      USERNAME: "me",
      USERSID: "S-1-5-21-999",
    });
    expect(summary.trusted.map((entry) => entry.principal)).toContain("DOMAIN\\me");
    expect(summary.untrustedWorld.some((entry) => entry.principal === "Everyone")).toBe(true);
    expect(summary.untrustedGroup.some((entry) => entry.principal === "*S-1-5-21-123")).toBe(true);
    expect(formatWindowsAclSummary({ ok: true, entries, ...summary })).toContain("Everyone");
    expect(formatWindowsAclSummary({ ok: false, entries: [], trusted: [], untrustedWorld: [], untrustedGroup: [] }))
      .toBe("unknown");
    expect(resolveWindowsUserPrincipal({ USERDOMAIN: "DOMAIN", USERNAME: "me" })).toBe(
      "DOMAIN\\me",
    );
    expect(resolveWindowsUserPrincipal({}, () => ({ username: "fallback" }))).toBe("fallback");
    expect(createIcaclsResetCommand(target, { isDir: true, userInfo: () => ({}) })).toBeNull();
    expect(
      formatIcaclsResetCommand(String.raw`C:\Secrets\token.txt`, {
        isDir: true,
        env: { SystemRoot: "D:\\Windows", USERNAME: "me" },
      }),
    ).toContain('"me:(OI)(CI)F"');
    expect(modeBits(0o100777)).toBe(0o777);
  });

  it("classifies broad Windows SID principals as world-equivalent", () => {
    const entries = [
      "*S-1-5-7",
      "*S-1-5-32-546",
      "*S-1-5-4",
      "*S-1-2-0",
      "*S-1-5-2",
      "NT AUTHORITY\\ANONYMOUS LOGON",
      "BUILTIN\\Guests",
    ].map((principal) => ({
      principal,
      rights: ["R"],
      rawRights: "(R)",
      canRead: true,
      canWrite: false,
    }));

    const summary = summarizeWindowsAcl(entries, { USERSID: "S-1-5-7" });
    expect(summary.untrustedWorld.map((entry) => entry.principal)).toEqual([
      "*S-1-5-7",
      "*S-1-5-32-546",
      "*S-1-5-4",
      "*S-1-2-0",
      "*S-1-5-2",
      "NT AUTHORITY\\ANONYMOUS LOGON",
      "BUILTIN\\Guests",
    ]);
    expect(summary.trusted).toEqual([]);
    expect(summary.untrustedGroup).toEqual([]);
  });

  it("reports broad Windows SID writes as world-writable", async () => {
    const target = path.join(root, "windows-acl-token.txt");
    await fs.writeFile(target, "secret", { mode: 0o600 });
    const exec = vi.fn(async (command: string) => {
      if (command.toLowerCase().endsWith("powershell.exe")) {
        return {
          stdout: JSON.stringify({
            ownerSid: "S-1-5-7",
            currentUserSid: "S-1-5-7",
          }),
          stderr: "",
        };
      }
      return {
        stdout: `${target} *S-1-5-18:(F)\n *S-1-5-7:(F)\n`,
        stderr: "",
      };
    });

    const result = await inspectPathPermissions(target, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows", USERSID: "S-1-5-7" },
      exec,
    });
    expect(result.ok).toBe(true);
    expect(result.worldWritable).toBe(true);
    expect(result.groupWritable).toBe(false);
  });

  it("reports a foreign Windows owner even when the visible ACL is read-only", async () => {
    const target = path.join(root, "windows-foreign-owner.txt");
    await fs.writeFile(target, "secret", { mode: 0o600 });
    const exec = vi.fn(async (command: string) => {
      if (command.toLowerCase().endsWith("powershell.exe")) {
        return {
          stdout: JSON.stringify({
            owner: "DOMAIN\\attacker",
            ownerSid: "S-1-5-21-999",
            currentUserSid: "S-1-5-21-42",
          }),
          stderr: "",
        };
      }
      return {
        stdout: `${target} *S-1-5-21-42:(RX)\n*S-1-5-18:(F)\n*S-1-5-32-544:(F)\n`,
        stderr: "",
      };
    });

    const result = await inspectPathPermissions(target, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      exec,
    });

    expect(result).toMatchObject({
      source: "windows-acl",
      groupWritable: false,
      worldWritable: false,
      ownerSid: "s-1-5-21-999",
      ownerTrusted: false,
    });
  });

  it.each(["S-1-5-21-42", "S-1-5-18", "S-1-5-32-544"])(
    "trusts the supported Windows owner SID %s",
    async (ownerSid) => {
      const target = path.join(root, `windows-trusted-owner-${ownerSid}.txt`);
      await fs.writeFile(target, "secret", { mode: 0o600 });
      const exec = vi.fn(async (command: string) => {
        if (command.toLowerCase().endsWith("powershell.exe")) {
          return {
            stdout: JSON.stringify({
              owner: ownerSid,
              ownerSid,
              currentUserSid: "S-1-5-21-42",
            }),
            stderr: "",
          };
        }
        return {
          stdout: `${target} *S-1-5-21-42:(RX)\n*S-1-5-18:(F)\n*S-1-5-32-544:(F)\n`,
          stderr: "",
        };
      });

      const result = await inspectPathPermissions(target, {
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        exec,
      });

      expect(result.ownerSid).toBe(ownerSid.toLowerCase());
      expect(result.ownerTrusted).toBe(true);
    },
  );

  it("queries the canonical Windows owner SID without a friendly-name round trip", async () => {
    const target = path.join(root, "windows-canonical-owner.txt");
    await fs.writeFile(target, "secret", { mode: 0o600 });
    const exec = vi.fn(async (command: string, _args: string[]) => {
      if (command.toLowerCase().endsWith("powershell.exe")) {
        return {
          stdout: JSON.stringify({
            ownerSid: "S-1-5-21-42",
            currentUserSid: "S-1-5-21-42",
          }),
          stderr: "",
        };
      }
      return { stdout: `${target} *S-1-5-21-42:(F)\n`, stderr: "" };
    });

    await inspectPathPermissions(target, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      exec,
    });

    const ownerArgs = exec.mock.calls[0]?.[1];
    const ownerQuery = Buffer.from(ownerArgs?.[4] ?? "", "base64").toString("utf16le");
    expect(ownerQuery).toContain(
      "$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    );
    expect(ownerQuery).toContain("[IO.File]::GetAccessControl($p,$sections)");
    expect(ownerQuery).toContain(
      "$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])",
    );
    expect(ownerQuery).not.toContain("Get-Acl");
    expect(ownerQuery).not.toContain("$acl.Owner");
  });

  it("leaves Windows ownership unverified when the owner query fails", async () => {
    const target = path.join(root, "windows-owner-query-failure.txt");
    await fs.writeFile(target, "secret", { mode: 0o600 });
    const exec = vi.fn(async (command: string) => {
      if (command.toLowerCase().endsWith("powershell.exe")) {
        throw new Error("owner lookup failed");
      }
      return {
        stdout: `${target} *S-1-5-21-42:(RX)\n`,
        stderr: "",
      };
    });

    const result = await inspectPathPermissions(target, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      exec,
    });

    expect(result.source).toBe("unknown");
    expect(result.ownerSid).toBeUndefined();
    expect(result.ownerTrusted).toBeUndefined();
    expect(result.ownerError).toContain("owner lookup failed");
    expect(result.error).toContain("Windows owner inspection failed");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("fails Windows ACL verification closed when a principal SID cannot be translated", async () => {
    const target = path.join(root, "windows-untranslated-principal.txt");
    await fs.writeFile(target, "secret", { mode: 0o600 });
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({
        ownerSid: "S-1-5-21-42",
        currentUserSid: "S-1-5-21-42",
        principalTranslationFailed: true,
      }),
      stderr: "",
    }));

    const result = await inspectPathPermissions(target, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      exec,
    });

    expect(result).toMatchObject({
      source: "unknown",
      ownerTrusted: true,
      error: expect.stringContaining("principal SID translation failed"),
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("does not trust well-known local owners on remote Windows filesystems", async () => {
    const target = path.join(root, "windows-remote-owner.txt");
    await fs.writeFile(target, "secret", { mode: 0o600 });
    const exec = vi.fn(async (command: string) => {
      if (command.toLowerCase().endsWith("powershell.exe")) {
        return {
          stdout: JSON.stringify({
            ownerSid: "S-1-5-32-544",
            currentUserSid: "S-1-5-21-42",
            remote: true,
          }),
          stderr: "",
        };
      }
      return { stdout: `${target} *S-1-5-32-544:(F)\n`, stderr: "" };
    });

    const result = await inspectPathPermissions(target, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      exec,
    });

    expect(result.ownerTrusted).toBe(false);
  });

  it("resolves the current user SID when ACL output only contains an unknown SID", async () => {
    const target = String.raw`C:\Secrets\token.txt`;
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: `${target} *S-1-5-21-42:(F)\nEveryone:(R)\n`,
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ name: "Everyone", sid: "S-1-1-0" }]),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: '"USER","SID"\n"DOMAIN\\me","S-1-5-21-42"\n',
        stderr: "",
      });

    const result = await inspectWindowsAcl(target, { exec, env: { SystemRoot: "C:\\Windows" } });
    expect(result.ok).toBe(true);
    expect(result.trusted.some((entry) => entry.principal === "*S-1-5-21-42")).toBe(true);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("classifies friendly ACL names by authoritative SID instead of spoofed environment names", async () => {
    const target = String.raw`C:\Secrets\token.txt`;
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: `${target} DOMAIN\\attacker:(F)\n`,
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ name: "DOMAIN\\attacker", sid: "S-1-5-21-999" }]),
        stderr: "",
      })
      .mockResolvedValueOnce({
        stdout: '"USER","SID"\n"DOMAIN\\me","S-1-5-21-42"\n',
        stderr: "",
      });

    const result = await inspectWindowsAcl(target, {
      exec,
      env: {
        SystemRoot: "C:\\Windows",
        USERDOMAIN: "DOMAIN",
        USERNAME: "attacker",
        USERSID: "S-1-5-21-999",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.trusted).toEqual([]);
    expect(result.untrustedGroup).toMatchObject([
      { principal: "DOMAIN\\attacker", sid: "s-1-5-21-999", canWrite: true },
    ]);
  });
});

describe("directory walking", () => {
  it("keeps the legacy result shape source-compatible", () => {
    const result: WalkDirectoryResult = {
      entries: [],
      scannedEntryCount: 0,
      truncated: false,
    };

    expect(result.failedDirs).toBeUndefined();
  });

  it("walks bounded trees and reports truncation", async () => {
    await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(root, "a", "one.txt"), "1");
    await fs.writeFile(path.join(root, "a", "b", "two.txt"), "2");

    const shallow = walkDirectorySync(root, { maxDepth: 1 });
    expect(shallow.entries.map((entry) => entry.relativePath)).toEqual(["a"]);

    const files = await walkDirectory(root, {
      include: (entry) => entry.kind === "file",
    });
    expect(files.entries.map((entry) => entry.relativePath).sort()).toEqual([
      path.join("a", "b", "two.txt"),
      path.join("a", "one.txt"),
    ]);

    const truncated = walkDirectorySync(root, { maxEntries: 1 });
    expect(truncated.truncated).toBe(true);
    expect(truncated.scannedEntryCount).toBe(1);
  });

  itPosix("does not recurse forever through followed symlink cycles", async () => {
    await fs.mkdir(path.join(root, "a"), { recursive: true });
    await fs.writeFile(path.join(root, "a", "file.txt"), "1");
    await fs.symlink(root, path.join(root, "a", "loop"));

    const scan = await walkDirectory(root, { symlinks: "follow" });
    expect(scan.truncated).toBe(false);
    expect(scan.entries.map((entry) => entry.relativePath).sort()).toEqual([
      "a",
      path.join("a", "file.txt"),
      path.join("a", "loop"),
    ]);
  });

  it("leaves failedDirs empty when every directory is readable", async () => {
    await fs.mkdir(path.join(root, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(root, "a", "one.txt"), "1");

    expect((await walkDirectory(root)).failedDirs).toEqual([]);
    expect(walkDirectorySync(root).failedDirs).toEqual([]);
  });

  itPosix("reports an unreadable subtree in failedDirs without dropping readable siblings", async () => {
    await fs.mkdir(path.join(root, "readable"), { recursive: true });
    await fs.writeFile(path.join(root, "readable", "ok.txt"), "1");
    const blocked = path.join(root, "blocked");
    await fs.mkdir(blocked, { recursive: true });
    await fs.writeFile(path.join(blocked, "hidden.txt"), "secret");
    await fs.chmod(blocked, 0o000);
    try {
      const scan = await walkDirectory(root, { include: (entry) => entry.kind === "file" });

      // The readable sibling is still enumerated.
      expect(scan.entries.map((entry) => entry.relativePath)).toContain(
        path.join("readable", "ok.txt"),
      );
      // The unreadable subtree contributes no entries.
      expect(scan.entries.map((entry) => entry.relativePath)).not.toContain(
        path.join("blocked", "hidden.txt"),
      );
      // ...but the failure is reported, not silently swallowed.
      expect(scan.failedDirs.map((failure) => failure.relativePath)).toEqual(["blocked"]);
      expect(scan.failedDirs[0]).toMatchObject({ path: blocked, depth: 1 });
      expect((scan.failedDirs[0]?.error as NodeJS.ErrnoException).code).toBe("EACCES");
    } finally {
      await fs.chmod(blocked, 0o755);
    }
  });

  itPosix("reports an unreadable walk root in failedDirs with an empty listing", async () => {
    const scanRoot = path.join(root, "scan");
    await fs.mkdir(scanRoot, { recursive: true });
    await fs.writeFile(path.join(scanRoot, "file.txt"), "1");
    await fs.chmod(scanRoot, 0o000);
    try {
      const scan = await walkDirectory(scanRoot);

      expect(scan.entries).toEqual([]);
      expect(scan.failedDirs.map((failure) => failure.relativePath)).toEqual([""]);
      expect(scan.failedDirs[0]).toMatchObject({ path: scanRoot, depth: 0 });
      expect((scan.failedDirs[0]?.error as NodeJS.ErrnoException).code).toBe("EACCES");
    } finally {
      await fs.chmod(scanRoot, 0o755);
    }
  });

  itPosix("reports unreadable directories from the synchronous walk too", async () => {
    await fs.mkdir(path.join(root, "readable"), { recursive: true });
    await fs.writeFile(path.join(root, "readable", "ok.txt"), "1");
    const blocked = path.join(root, "blocked");
    await fs.mkdir(blocked, { recursive: true });
    await fs.chmod(blocked, 0o000);
    try {
      const scan = walkDirectorySync(root, { include: (entry) => entry.kind === "file" });

      expect(scan.entries.map((entry) => entry.relativePath)).toContain(
        path.join("readable", "ok.txt"),
      );
      expect(scan.failedDirs.map((failure) => failure.relativePath)).toEqual(["blocked"]);
      expect(scan.failedDirs[0]).toMatchObject({ path: blocked, depth: 1 });
      expect((scan.failedDirs[0]?.error as NodeJS.ErrnoException).code).toBe("EACCES");
    } finally {
      await fs.chmod(blocked, 0o755);
    }
  });

  itPosix("reports nested failed directory depth relative to the walk root", async () => {
    const parent = path.join(root, "parent");
    const blocked = path.join(parent, "blocked");
    await fs.mkdir(blocked, { recursive: true });
    await fs.writeFile(path.join(blocked, "hidden.txt"), "secret");
    await fs.chmod(blocked, 0o000);
    try {
      const scan = await walkDirectory(root);

      expect(scan.failedDirs.map((failure) => failure.relativePath)).toEqual([
        path.join("parent", "blocked"),
      ]);
      expect(scan.failedDirs[0]).toMatchObject({ path: blocked, depth: 2 });
      expect((scan.failedDirs[0]?.error as NodeJS.ErrnoException).code).toBe("EACCES");
    } finally {
      await fs.chmod(blocked, 0o755);
    }
  });
});

describe("private file store mode", () => {
  it("writes JSON under the store root", async () => {
    const store = fileStore({ rootDir: root, private: true });
    await store.writeJson("nested/state.json", { ok: true }, { trailingNewline: true });
    expect(await fs.readFile(path.join(root, "nested", "state.json"), "utf8")).toBe(
      '{\n  "ok": true\n}\n',
    );
    await expect(store.readJson("nested/state.json")).resolves.toEqual({ ok: true });
  });

  it("rejects paths outside the store root", async () => {
    const store = fileStore({ rootDir: root, private: true });
    await expect(store.writeText("../escape.txt", "nope")).rejects.toThrow(/relative path/);
    await expect(store.readTextIfExists("../escape.txt")).rejects.toThrow(/outside workspace root/);
  });

  it("supports sync JSON writes", async () => {
    const filePath = fileStoreSync({ rootDir: root, private: true }).writeJson("sync.json", {
      ok: true,
    });
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ ok: true });
  });

  it("has explicit lenient read helpers", async () => {
    const store = fileStore({ rootDir: root, private: true });
    await store.writeText("state.txt", "hello");
    await store.writeJson("state.json", { ok: true });

    await expect(store.readTextIfExists("state.txt")).resolves.toBe("hello");
    await expect(store.readJsonIfExists("state.json")).resolves.toEqual({ ok: true });
    await expect(store.readTextIfExists("missing.txt")).resolves.toBeNull();
    await expect(store.readJsonIfExists("missing.json")).resolves.toBeNull();
  });
});

describe("file locks", () => {
  it("supports await using cleanup", async () => {
    const targetPath = path.join(root, "locked.txt");
    let lockPath = "";

    {
      await using lock = await acquireFileLock(targetPath, {
        managerKey: `test-${Date.now()}-${Math.random()}`,
        staleMs: 60_000,
        payload: () => ({ owner: "test" }),
      });
      lockPath = lock.lockPath;
      await expect(fs.stat(lockPath)).resolves.toMatchObject({});
    }

    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("supports manager lifecycle and top-level withFileLock", async () => {
    const targetPath = path.join(root, "managed-lock.txt");
    const manager = createFileLockManager(`manager-${Date.now()}-${Math.random()}`);

    const lock = await manager.acquire(targetPath, {
      staleMs: 60_000,
      metadata: { suite: "new-primitives" },
      payload: () => ({ owner: "manager" }),
    });
    const queued = manager.acquire(targetPath, {
      staleMs: 60_000,
      timeoutMs: 1_000,
      retry: { minTimeout: 1, maxTimeout: 2 },
      payload: () => ({ owner: "manager" }),
    });
    expect(manager.heldEntries()).toHaveLength(1);
    expect(manager.heldEntries()[0]?.metadata).toEqual({ suite: "new-primitives" });
    await lock.release();
    const queuedLock = await queued;
    await queuedLock.release();
    expect(manager.heldEntries()).toEqual([]);

    await expect(
      manager.withLock(
        targetPath,
        { staleMs: 60_000, payload: () => ({ owner: "manager" }) },
        async () => "ok",
      ),
    ).resolves.toBe("ok");

    await expect(
      withFileLock(
        path.join(root, "top-level-lock.txt"),
        { staleMs: 60_000, payload: () => ({ owner: "top-level" }) },
        async () => "locked",
      ),
    ).resolves.toBe("locked");
    manager.reset();
    await manager.drain();
  });
});

describe("regular file append", () => {
  it("keeps append flags usable when O_NOFOLLOW is unavailable", () => {
    expect(
      resolveRegularFileAppendFlags({
        O_APPEND: 0x01,
        O_CREAT: 0x02,
        O_WRONLY: 0x04,
      }),
    ).toBe(0x07);
  });

  it("appends with restrictive permissions and honors max bytes", async () => {
    const filePath = path.join(root, "events.jsonl");
    await appendRegularFile({ filePath, content: "12345\n", maxFileBytes: 6 });
    await appendRegularFile({ filePath, content: "after\n", maxFileBytes: 6 });

    expect(await fs.readFile(filePath, "utf8")).toBe("12345\n");
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("appends synchronously with restrictive permissions and honors max bytes", async () => {
    const filePath = path.join(root, "sync-events.jsonl");
    appendRegularFileSync({ filePath, content: "12345\n", maxFileBytes: 6 });
    appendRegularFileSync({ filePath, content: "after\n", maxFileBytes: 6 });

    expect(await fs.readFile(filePath, "utf8")).toBe("12345\n");
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  itPosix("rejects symlink leaves synchronously", async () => {
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    await fs.writeFile(target, "secret", "utf8");
    await fs.symlink(target, link);

    expect(() => appendRegularFileSync({ filePath: link, content: "line\n" })).toThrow(/symlink/);
    expect(await fs.readFile(target, "utf8")).toBe("secret");
  });

  itPosix("rejects symlink parents", async () => {
    const targetDir = path.join(root, "target");
    const linkDir = path.join(root, "link");
    await fs.mkdir(targetDir);
    await fs.symlink(targetDir, linkDir);

    await expect(
      appendRegularFile({
        filePath: path.join(linkDir, "events.jsonl"),
        content: "line\n",
        rejectSymlinkParents: true,
      }),
    ).rejects.toThrow(/symlinked directory/);
    await expect(fs.stat(path.join(targetDir, "events.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("pins regular file reads against symlink swaps", async () => {
    const filePath = path.join(root, "read-target.txt");
    const secretPath = path.join(root, "read-secret.txt");
    await fs.writeFile(filePath, "safe", "utf8");
    await fs.writeFile(secretPath, "secret", "utf8");

    const originalLstat = fs.lstat.bind(fs);
    let swapped = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      if (!swapped && args[0] === filePath) {
        swapped = true;
        await fs.rm(filePath, { force: true });
        await fs.symlink(secretPath, filePath);
      }
      return stat;
    });

    try {
      await expect(readRegularFile({ filePath })).rejects.toThrow();
      await expect(fs.readFile(secretPath, "utf8")).resolves.toBe("secret");
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("pins sync regular file reads against symlink swaps", async () => {
    const filePath = path.join(root, "sync-read-target.txt");
    const secretPath = path.join(root, "sync-read-secret.txt");
    await fs.writeFile(filePath, "safe", "utf8");
    await fs.writeFile(secretPath, "secret", "utf8");

    const originalLstatSync = syncFs.lstatSync.bind(syncFs);
    let swapped = false;
    const lstatSpy = vi.spyOn(syncFs, "lstatSync").mockImplementation((...args) => {
      const stat = originalLstatSync(...args);
      if (!swapped && args[0] === filePath) {
        swapped = true;
        syncFs.rmSync(filePath, { force: true });
        syncFs.symlinkSync(secretPath, filePath);
      }
      return stat;
    });

    try {
      expect(() => readRegularFileSync({ filePath })).toThrow();
      await expect(fs.readFile(secretPath, "utf8")).resolves.toBe("secret");
    } finally {
      lstatSpy.mockRestore();
    }
  });
});

describe("atomic file replacement", () => {
  it("retries transient rename failures and preserves destination spelling", async () => {
    const filePath = path.join(root, "state.json");
    const originalRename = fs.rename.bind(fs);
    const destinations: string[] = [];
    let busyCount = 0;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (src, dest) => {
      destinations.push(String(dest));
      if (busyCount < 2) {
        busyCount++;
        const error = new Error("busy") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return await originalRename(src, dest);
    });

    try {
      await replaceFileAtomic({
        filePath,
        content: "ok",
        renameMaxRetries: 2,
        renameRetryBaseDelayMs: 0,
      });
    } finally {
      renameSpy.mockRestore();
    }

    expect(busyCount).toBe(2);
    expect(destinations).toEqual([filePath, filePath, filePath]);
    expect(await fs.readFile(filePath, "utf8")).toBe("ok");
  });

  it("can fall back to copy/unlink for permission-style rename failures", async () => {
    const filePath = path.join(root, "windows.json");
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
      const error = new Error("permission") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });

    try {
      await replaceFileAtomic({
        filePath,
        content: "copied",
        copyFallbackOnPermissionError: true,
      });
    } finally {
      renameSpy.mockRestore();
    }

    expect(await fs.readFile(filePath, "utf8")).toBe("copied");
  });

  it("cleans the temp file after failed replacement", async () => {
    const filePath = path.join(root, "fail.json");
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    try {
      await expect(
        replaceFileAtomic({
          filePath,
          content: "nope",
          tempPrefix: ".cron-store",
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      renameSpy.mockRestore();
    }

    const entries = await fs.readdir(root);
    expect(entries.filter((entry) => entry.startsWith(".cron-store"))).toEqual([]);
  });

  itPosix("applies requested directory and file modes", async () => {
    const filePath = path.join(root, "nested", "mode.txt");
    await replaceFileAtomic({
      filePath,
      content: "mode",
      dirMode: 0o755,
      mode: 0o644,
    });

    expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o755);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o644);
  });

  it("supports sync replacement", async () => {
    const filePath = path.join(root, "sync", "state.txt");
    replaceFileAtomicSync({
      filePath,
      content: "sync",
      dirMode: 0o755,
      mode: 0o644,
      tempPrefix: ".sync-replace",
    });

    expect(await fs.readFile(filePath, "utf8")).toBe("sync");
    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(filePath))).mode & 0o777).toBe(0o755);
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o644);
    }
  });

  it("preserves an existing destination mode when requested", async () => {
    const filePath = path.join(root, "preserve-mode.txt");
    await fs.writeFile(filePath, "old", { mode: 0o640 });
    await fs.chmod(filePath, 0o640);

    await replaceFileAtomic({
      filePath,
      content: "new",
      preserveExistingMode: true,
    });

    expect(await fs.readFile(filePath, "utf8")).toBe("new");
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o640);
    }
  });

  it("syncs the temp file before rename when requested", async () => {
    const filePath = path.join(root, "sync-temp.txt");
    let syncCalls = 0;
    const fileSystem = {
      promises: {
        ...fs,
        open: async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args);
          handle.sync = async () => {
            syncCalls += 1;
          };
          return handle;
        },
      },
    };

    await replaceFileAtomic({
      filePath,
      content: "durable",
      syncTempFile: true,
      fileSystem,
    });

    expect(syncCalls).toBe(1);
    expect(await fs.readFile(filePath, "utf8")).toBe("durable");
  });

  it("can use injected async filesystem operations", async () => {
    const filePath = path.join(root, "injected.txt");
    const renamed: string[] = [];
    const fileSystem = {
      promises: {
        ...fs,
        rename: async (src: string, dest: string) => {
          renamed.push(dest);
          await fs.rename(src, dest);
        },
      },
    };

    await replaceFileAtomic({
      filePath,
      content: "injected",
      fileSystem,
    });

    expect(renamed).toEqual([filePath]);
    expect(await fs.readFile(filePath, "utf8")).toBe("injected");
  });

  it("syncs the parent directory when requested", async () => {
    const filePath = path.join(root, "parent-sync.txt");
    let openedDir = "";
    const fileSystem = {
      promises: {
        ...fs,
        open: async (...args: Parameters<typeof fs.open>) => {
          openedDir = String(args[0]);
          const handle = await fs.open(...args);
          handle.sync = async () => undefined;
          return handle;
        },
      },
    };

    await replaceFileAtomic({
      filePath,
      content: "durable-parent",
      syncParentDir: true,
      fileSystem,
    });

    expect(openedDir).toBe(root);
  });

  it("cleans the sync temp file after failed replacement", async () => {
    const filePath = path.join(root, "sync-fail.json");
    const renameSpy = vi.spyOn(syncFs, "renameSync").mockImplementation(() => {
      const error = new Error("denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    try {
      expect(() =>
        replaceFileAtomicSync({
          filePath,
          content: "nope",
          tempPrefix: ".sync-store",
        }),
      ).toThrow();
    } finally {
      renameSpy.mockRestore();
    }

    const entries = await fs.readdir(root);
    expect(entries.filter((entry) => entry.startsWith(".sync-store"))).toEqual([]);
  });
});

describe("path moves", () => {
  it("moves paths with rename", async () => {
    const from = path.join(root, "from.txt");
    const to = path.join(root, "to.txt");
    await fs.writeFile(from, "moved");

    await movePathWithCopyFallback({ from, to });

    await expect(fs.access(from)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(to, "utf8")).toBe("moved");
  });
});

describe("sibling temp files", () => {
  it("writes through a sibling temp file and cleans failures", async () => {
    const finalPath = path.join(root, "download.bin");
    const writtenTempPaths: string[] = [];
    const result = await writeSiblingTempFile({
      dir: root,
      mode: 0o644,
      writeTemp: async (tempPath) => {
        writtenTempPaths.push(tempPath);
        await fs.writeFile(tempPath, "streamed");
        return { name: "download.bin" };
      },
      resolveFinalPath: (value) => path.join(root, value.name),
    });

    expect(result.filePath).toBe(finalPath);
    expect(await fs.readFile(finalPath, "utf8")).toBe("streamed");
    await expect(fs.access(writtenTempPaths[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects final paths outside the temp directory", async () => {
    await expect(
      writeSiblingTempFile({
        dir: root,
        writeTemp: async (tempPath) => {
          await fs.writeFile(tempPath, "escape");
          return "escape";
        },
        resolveFinalPath: () => path.join(path.dirname(root), "escape.txt"),
      }),
    ).rejects.toThrow(/sibling temp directory/);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("regular file helpers", () => {
  it("rejects directories", async () => {
    await expect(statRegularFile(root)).rejects.toThrow(/regular file/);
  });
});

describe("path scope directory creation", () => {
  it("creates directories inside the root", async () => {
    const result = await pathScope(root, { label: "test root" }).ensureDir("a/b", { mode: 0o700 });
    expect(result).toEqual({ ok: true, path: path.join(root, "a", "b") });
    await expect(fs.stat(path.join(root, "a", "b"))).resolves.toMatchObject({});
  });

  it("rejects escapes", async () => {
    const result = await pathScope(root, { label: "test root" }).ensureDir("../out");
    expect(result.ok).toBe(false);
  });
});

describe("symlink parent guards", () => {
  it("rejects symlink path components", async () => {
    const real = path.join(root, "real");
    const link = path.join(root, "link");
    await fs.mkdir(real);
    await fs.symlink(real, link);
    await expect(
      assertNoSymlinkParents({
        rootDir: root,
        targetPath: path.join(link, "file.txt"),
        requireDirectories: true,
      }),
    ).rejects.toThrow(/symlinked/);
  });

  it("has a sync variant", async () => {
    const real = path.join(root, "real-sync");
    const link = path.join(root, "link-sync");
    await fs.mkdir(real);
    await fs.symlink(real, link);
    expect(() =>
      assertNoSymlinkParentsSync({
        rootDir: root,
        targetPath: path.join(link, "file.txt"),
        requireDirectories: true,
      }),
    ).toThrow(/symlinked/);
  });
});
