import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LinuxRenameNoReplaceInput,
  renameLinuxNoReplaceSync,
} from "../src/linux-rename-command.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync }));
const { tempRoot } = useRealTempDirs();

const sourceParent = { dev: 9007199254740993n, ino: 9007199254740995n };
const targetParent = { dev: 9007199254740997n, ino: 9007199254740999n };
const sourceIdentity = { dev: 9007199254740993n, ino: 18446744073709551615n };

function input(pinned = true): LinuxRenameNoReplaceInput {
  return {
    source: {
      parentFd: 71, basename: "source-雪-'\"\n$();\\\ud800", parentIdentity: sourceParent,
      identity: sourceIdentity, links: 9007199254740993n, ...(pinned ? { fd: 73 } : {}),
    },
    target: { parentFd: 72, basename: "target-🦞-'\"\n$();\\", parentIdentity: targetParent },
  };
}

function reply(value: unknown): SpawnSyncReturns<string> {
  const stdout = `${JSON.stringify(value)}\n`;
  return { pid: 123, status: 0, signal: null, stdout, stderr: "", output: [null, stdout, ""] };
}

const successfulReply = { phase: "rename", result: 0, errno: 0, code: null };
const resourceErrors = ["EMFILE", "ENFILE", "EAGAIN", "ENOMEM", "EBADF", "EIO"];

beforeEach(() => {
  spawnSync.mockReset();
  spawnSync.mockReturnValue(reply(successfulReply));
});

describe.runIf(process.platform === "linux")("Linux real no-replace command", () => {
  async function fixture(sourceName = "source", targetName = "target") {
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnSync.mockImplementation(real.spawnSync);
    const directory = await tempRoot("fs-safe-linux-command-");
    const source = path.join(directory, sourceName);
    const target = path.join(directory, targetName);
    fs.writeFileSync(source, "original", { mode: 0o600 });
    fs.chmodSync(source, 0);
    const parentIdentity = fs.lstatSync(directory, { bigint: true });
    const identity = fs.lstatSync(source, { bigint: true });
    const parentFd = fs.openSync(directory, 0x0020_0000 | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const sourceFd = fs.openSync(source, 0x0020_0000 | fs.constants.O_NOFOLLOW);
    const request: LinuxRenameNoReplaceInput = {
      source: { parentFd, parentIdentity, basename: sourceName, identity, links: 1n, fd: sourceFd },
      target: { parentFd, parentIdentity, basename: targetName },
    };
    return {
      source, target, request, identity,
      close: () => { fs.closeSync(sourceFd); fs.closeSync(parentFd); },
    };
  }

  it.each([
    ["source\n'\"$()\\雪", "target\n'\"$()\\🦞"],
    ["source-\ud800", "target-\udfff"],
    ["source-\udfff", "target-\ud800"],
  ])("atomically moves unreadable %j to %j and preserves a competing target", async (sourceName, targetName) => {
    const files = await fixture(sourceName, targetName);
    try {
      renameLinuxNoReplaceSync(files.request);
      expect(fs.existsSync(files.source)).toBe(false);
      const after = fs.lstatSync(files.target, { bigint: true });
      expect({ dev: after.dev, ino: after.ino, mode: after.mode }).toEqual({
        dev: files.identity.dev, ino: files.identity.ino, mode: files.identity.mode,
      });
      fs.chmodSync(files.target, 0o600);
      fs.writeFileSync(files.source, "second source");
      const collisionIdentity = fs.lstatSync(files.source, { bigint: true });
      const collision = {
        ...files.request,
        source: { ...files.request.source, identity: collisionIdentity, fd: undefined },
      };
      expect(() => renameLinuxNoReplaceSync(collision)).toThrowError(expect.objectContaining({
        code: "already-exists", details: { commit: "unknown" },
      }));
      expect(fs.readFileSync(files.target, "utf8")).toBe("original");
      expect(fs.readFileSync(files.source, "utf8")).toBe("second source");
      expect(fs.lstatSync(files.source, { bigint: true }).ino).toBe(collisionIdentity.ino);
    } finally { files.close(); }
  });

  it.each(["source", "parent", "links"])("rejects changed %s identity in the child before dispatch", async changed => {
    const files = await fixture();
    if (changed === "source") {
      files.request.source.identity = { ...files.identity, ino: files.identity.ino + 1n };
    }
    if (changed === "parent") {
      const expected = files.request.source.parentIdentity;
      files.request.source.parentIdentity = { ...expected, ino: expected.ino + 1n };
    }
    if (changed === "links") files.request.source.links = 2n;
    try {
      expect(() => renameLinuxNoReplaceSync(files.request)).toThrowError(expect.objectContaining({
        code: "path-mismatch", details: { commit: "not-attempted" },
      }));
      expect(fs.existsSync(files.source)).toBe(true);
      expect(fs.existsSync(files.target)).toBe(false);
    } finally { files.close(); }
  });
});

afterEach(() => vi.restoreAllMocks());

describe("Linux atomic no-replace command", () => {
  it("uses only stock isolated Python with fixed code and exact UTF-8 names and bigint identities on stdin", () => {
    const params = input();
    expect(renameLinuxNoReplaceSync(params)).toBeUndefined();

    expect(spawnSync).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSync.mock.calls[0]!;
    expect(command).toBe("/usr/bin/python3");
    expect(args).toHaveLength(6);
    expect(args.slice(0, 5)).toEqual(["-I", "-S", "-X", "utf8", "-c"]);
    expect(args[5]).not.toContain(params.source.basename);
    expect(args[5]).not.toContain(params.target.basename);
    expect(options).toEqual({
      input: expect.any(String), encoding: "utf8", cwd: "/",
      env: { LANG: "C", LC_ALL: "C" }, timeout: 30_000, maxBuffer: 64 * 1024,
      stdio: ["pipe", "pipe", "pipe", 71, 72, 73],
    });
    expect(JSON.parse(options.input)).toEqual({
      sourceName: Buffer.from(params.source.basename, "utf8").toString("base64"),
      targetName: Buffer.from(params.target.basename, "utf8").toString("base64"),
      sourceParent: { dev: "9007199254740993", ino: "9007199254740995" },
      targetParent: { dev: "9007199254740997", ino: "9007199254740999" },
      source: { dev: "9007199254740993", ino: "18446744073709551615" },
      links: "9007199254740993", sourcePinned: true,
    });

    renameLinuxNoReplaceSync({
      ...params, target: { ...params.target, basename: "different-name" },
    });
    expect(spawnSync.mock.calls[1]![1]).toEqual(args);
  });

  it("omits the borrowed source descriptor when only parent descriptors are available", () => {
    renameLinuxNoReplaceSync(input(false));
    const options = spawnSync.mock.calls[0]![2];
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe", 71, 72]);
    expect(JSON.parse(options.input).sourcePinned).toBe(false);
  });

  it.each([
    ["unavailable", "helper-unavailable"],
    ["path-mismatch", "path-mismatch"],
  ])("recognizes explicit preparation rejection %s before mutation", (error, code) => {
    spawnSync.mockReturnValue(reply({ phase: "prepare", error }));
    expect(() => renameLinuxNoReplaceSync(input())).toThrowError(expect.objectContaining({
      code, details: { commit: "not-attempted" },
    }));
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it.each([["EEXIST", 17], ["ENOTEMPTY", 39]])("preserves atomic collision %s without retrying", (code, errno) => {
    spawnSync.mockReturnValue(reply({ phase: "rename", result: -1, errno, code }));
    expect(() => renameLinuxNoReplaceSync(input())).toThrowError(expect.objectContaining({
      code: "already-exists", details: { commit: "unknown" },
      cause: expect.objectContaining({ code, errno: -Number(errno), syscall: "renameat2" }),
    }));
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it.each(["ENOENT", "EACCES", "ENOEXEC"])("recognizes definitely unstarted %s", (code) => {
    const error = Object.assign(new Error("spawn failed"), { code });
    spawnSync.mockReturnValue({ ...reply(null), pid: 0, status: null, signal: null, error });
    expect(() => renameLinuxNoReplaceSync(input())).toThrowError(expect.objectContaining({
      code: "helper-unavailable", details: { commit: "not-attempted" }, cause: error,
    }));
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it.each([...resourceErrors, "ETIMEDOUT", undefined])("reports definitely unstarted failure %s without claiming mutation", code => {
    const error = Object.assign(new Error("could not spawn"), { code });
    spawnSync.mockReturnValue({ ...reply(null), pid: 0, status: null, signal: null, error });
    expect(() => renameLinuxNoReplaceSync(input())).toThrowError(expect.objectContaining({
      code: "helper-failed", details: { commit: "not-attempted" }, cause: error,
    }));
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it.each(resourceErrors.flatMap(code => [
    { pid: 123, status: null, signal: null, code },
    { pid: 0, status: 1, signal: null, code },
    { pid: 0, status: null, signal: "SIGTERM", code },
    { pid: undefined, status: null, signal: null, code },
  ]))("keeps potentially started resource failure $code/$pid/$status/$signal unknown", ({ code, ...result }) => {
    const error = Object.assign(new Error("resource failure"), { code });
    spawnSync.mockReturnValue({ ...reply(successfulReply), ...result, error });
    expect(() => renameLinuxNoReplaceSync(input())).toThrowError(expect.objectContaining({
      code: "helper-failed", details: { commit: "unknown" }, cause: error,
    }));
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    { pid: 123, status: null, signal: null, code: "ENOENT" },
    { pid: 123, status: null, signal: null, code: "EACCES" },
    { pid: 123, status: null, signal: null, code: "ENOEXEC" },
    { pid: 0, status: 1, signal: null, code: "ENOENT" },
    { pid: 0, status: 0, signal: null, code: "ENOENT" },
    { pid: 0, status: null, signal: "SIGTERM", code: "ENOENT" },
    { pid: 123, status: null, signal: null, code: "ETIMEDOUT" },
    { pid: undefined, status: null, signal: null, code: "ETIMEDOUT" },
    { pid: 0, status: null, signal: "SIGTERM", code: "ETIMEDOUT" },
    { pid: 123, status: null, signal: "SIGTERM", code: "ETIMEDOUT" },
    { pid: 123, status: 0, signal: null, code: "EPIPE" },
  ])("keeps ambiguous spawn result $code/$pid/$status/$signal unknown", ({ code, ...result }) => {
    const error = Object.assign(new Error("spawn failed"), { code });
    spawnSync.mockReturnValue({ ...reply(successfulReply), ...result, error });
    expect(() => renameLinuxNoReplaceSync(input())).toThrowError(expect.objectContaining({
      code: "helper-failed", details: { commit: "unknown" }, cause: error,
    }));
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 1 }, { status: null }, { signal: "SIGKILL" }, { stderr: "unexpected diagnostic" },
  ])("does not trust a success reply from abnormal process completion %j", (abnormal) => {
    spawnSync.mockReturnValue({ ...reply(successfulReply), ...abnormal });
    expect(() => renameLinuxNoReplaceSync(input())).toThrowError(expect.objectContaining({
      code: "helper-failed", details: { commit: "unknown" },
    }));
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it.each(["", "not json", "{}\n{}", "{\"phase\":\"rename\""])("rejects malformed reply %j as unknown", (stdout) => {
    spawnSync.mockReturnValue({ ...reply(null), stdout });
    expect(() => renameLinuxNoReplaceSync(input())).toThrowError(expect.objectContaining({
      code: "helper-failed", details: { commit: "unknown" },
    }));
  });

  it.each([
    null, [], true, "committed", 0, {},
    { phase: "prepare", error: "other" },
    { phase: "prepare", error: "unavailable", commit: "not-attempted" },
    { ...successfulReply, extra: true },
    { phase: "rename", result: 0, errno: 0 },
    { ...successfulReply, phase: "other" },
    { ...successfulReply, result: 1 },
    { ...successfulReply, errno: 1 },
    { ...successfulReply, code: "EIO" },
    { phase: "rename", result: -1, errno: "17", code: "EEXIST" },
    { phase: "rename", result: -1, errno: 1.5, code: "EEXIST" },
    { phase: "rename", result: -1, errno: 0, code: "EEXIST" },
    { phase: "rename", result: -1, errno: -17, code: "EEXIST" },
    { phase: "rename", result: -1, errno: 2147483648, code: "EEXIST" },
    { phase: "rename", result: -1, errno: 17, code: "eexist" },
    { phase: "rename", result: -1, errno: 17, code: null },
  ])("rejects an invalid reply shape as unknown: %j", (value) => {
    spawnSync.mockReturnValue(reply(value));
    expect(() => renameLinuxNoReplaceSync(input())).toThrowError(expect.objectContaining({
      code: "helper-failed", details: { commit: "unknown" },
    }));
  });

  it.each([
    ["EACCES", 13, "helper-failed"], ["EBADF", 9, "helper-failed"], ["EBUSY", 16, "helper-failed"],
    ["EEXIST", 17, "already-exists"], ["EINVAL", 22, "helper-unavailable"], ["EISDIR", 21, "helper-failed"],
    ["ELOOP", 40, "helper-failed"], ["EMLINK", 31, "helper-failed"], ["ENAMETOOLONG", 36, "helper-failed"],
    ["ENOENT", 2, "helper-failed"], ["ENOSPC", 28, "helper-failed"], ["ENOSYS", 38, "helper-unavailable"],
    ["ENOTDIR", 20, "helper-failed"], ["ENOTEMPTY", 39, "already-exists"], ["ENOTSUP", 95, "helper-unavailable"],
    ["EOPNOTSUPP", 95, "helper-unavailable"], ["EPERM", 1, "helper-failed"], ["EROFS", 30, "helper-failed"],
    ["ETXTBSY", 26, "helper-failed"], ["EXDEV", 18, "helper-failed"],
  ])("keeps ordinary syscall rejection %s indeterminate without retry", (code, errno, expectedCode) => {
    spawnSync.mockReturnValue(reply({ phase: "rename", result: -1, errno, code }));
    expect(() => renameLinuxNoReplaceSync(input())).toThrowError(expect.objectContaining({
      code: expectedCode, details: { commit: "unknown" },
      cause: expect.objectContaining({ code, errno: -Number(errno), syscall: "renameat2" }),
    }));
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it.each([["EIO", 5], ["ETIMEDOUT", 110], ["EUNKNOWN", 12345]])("keeps syscall failure %s conservative and terminal", (code, errno) => {
    spawnSync.mockReturnValue(reply({ phase: "rename", result: -1, errno, code }));
    expect(() => renameLinuxNoReplaceSync(input())).toThrowError(expect.objectContaining({
      code: "helper-failed", details: { commit: "unknown" },
      cause: expect.objectContaining({ code, errno: -Number(errno), syscall: "renameat2" }),
    }));
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});
