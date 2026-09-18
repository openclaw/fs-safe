import type { SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import { getSystemErrorName } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renameDarwinNoReplace } from "../src/darwin-move-command.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync }));
const { tempRoot } = useRealTempDirs();
const input = {
  source: { parentFd: 7, basename: "source" },
  target: { parentFd: 8, basename: "target" },
};
const resourceErrors = ["EMFILE", "ENFILE", "EAGAIN", "ENOMEM", "EBADF", "EIO"];

function response(stdout: string, changes: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return { pid: 123, status: 0, signal: null, output: [null, stdout, ""], stdout, stderr: "", ...changes };
}

beforeEach(() => {
  spawnSync.mockReset();
  spawnSync.mockReturnValue(response('{"result":0,"errno":0}'));
});
afterEach(() => vi.restoreAllMocks());

it("uses the fixed stock JXA host with inherited parents and names only on stdin", () => {
  const sourceName = "source\n'\"$()\\雪";
  const targetName = "target\n'\"$()\\☃";
  renameDarwinNoReplace({ source: { parentFd: 27, basename: sourceName }, target: { parentFd: 31, basename: targetName } });

  expect(spawnSync).toHaveBeenCalledOnce();
  const [executable, args, options] = spawnSync.mock.calls[0]!;
  expect(executable).toBe("/usr/bin/osascript");
  expect(args.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
  expect(args).toHaveLength(4);
  expect(args[3]).toContain('ObjC.bindFunction("renameatx_np"');
  expect(args[3]).toContain("$.renameatx_np(3,childName(input.sourceName),4,childName(input.targetName),4)");
  expect(args[3]).not.toContain(sourceName);
  expect(args[3]).not.toContain(targetName);
  expect(JSON.parse(options.input)).toEqual({ sourceName, targetName });
  expect(options).toEqual({
    input: JSON.stringify({ sourceName, targetName }),
    encoding: "utf8", cwd: "/", env: { LANG: "C", LC_ALL: "C" }, timeout: 30_000, maxBuffer: 64 * 1024,
    stdio: ["pipe", "pipe", "pipe", 27, 31],
  });
});

it.each([
  ["source-\ud800", "target-\udfff", "source-\ufffd", "target-\ufffd"],
  ["source-\udfff", "target-\ud800", "source-\ufffd", "target-\ufffd"],
  ["source-🚀", "target-🦞", "source-🚀", "target-🦞"],
])("matches Node UTF-8 encoding for both filename fields: %j / %j", (sourceName, targetName, sourceEncoded, targetEncoded) => {
  renameDarwinNoReplace({
    source: { parentFd: 7, basename: sourceName },
    target: { parentFd: 8, basename: targetName },
  });
  expect(JSON.parse(spawnSync.mock.calls[0]![2].input)).toEqual({
    sourceName: sourceEncoded, targetName: targetEncoded,
  });
});

it.each(["ENOENT", "EACCES", "ENOEXEC"])("marks a definitely unstarted %s as not attempted", code => {
  const error = Object.assign(new Error("spawn failed"), { code });
  spawnSync.mockReturnValue(response("", { pid: 0, status: null, signal: null, error }));
  expect(() => renameDarwinNoReplace(input)).toThrowError(expect.objectContaining({
    code: "helper-unavailable", cause: error, details: { commit: "not-attempted" },
  }));
});

it.each([...resourceErrors, "ETIMEDOUT", undefined])("reports definitely unstarted failure %s without claiming mutation", code => {
  const error = Object.assign(new Error("could not spawn"), { code });
  spawnSync.mockReturnValue(response("", { pid: 0, status: null, signal: null, error }));
  expect(() => renameDarwinNoReplace(input)).toThrowError(expect.objectContaining({
    code: "helper-failed", details: { commit: "not-attempted" }, cause: error,
  }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each(resourceErrors.flatMap(code => [
  { pid: 123, status: null, signal: null, code },
  { pid: 0, status: 1, signal: null, code },
  { pid: 0, status: null, signal: "SIGTERM" as const, code },
  { pid: undefined, status: null, signal: null, code },
]))("keeps potentially started resource failure $code/$pid/$status/$signal unknown", ({ code, ...state }) => {
  const error = Object.assign(new Error("resource failure"), { code });
  spawnSync.mockReturnValue(response('{"result":0,"errno":0}', { ...state, error }));
  expect(() => renameDarwinNoReplace(input)).toThrowError(expect.objectContaining({
    code: "helper-failed", details: { commit: "unknown" }, cause: error,
  }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each([
  { pid: 123, status: null, signal: null, code: "ENOENT" },
  { pid: 0, status: 1, signal: null, code: "EACCES" },
  { pid: 0, status: null, signal: "SIGTERM" as const, code: "ENOEXEC" },
  { pid: 123, status: null, signal: null, code: "ETIMEDOUT" },
  { pid: undefined, status: null, signal: null, code: "ETIMEDOUT" },
  { pid: 0, status: null, signal: "SIGTERM" as const, code: "ETIMEDOUT" },
  { pid: 123, status: null, signal: "SIGTERM" as const, code: "ETIMEDOUT" },
])("keeps uncertain spawn failures unknown: $code/$pid/$status/$signal", ({ code, ...state }) => {
  const error = Object.assign(new Error("spawn or pipe failed"), { code });
  spawnSync.mockReturnValue(response("", { ...state, error }));
  expect(() => renameDarwinNoReplace(input)).toThrowError(expect.objectContaining({
    code: "helper-failed", cause: error, details: { commit: "unknown" },
  }));
});

it.each([
  { status: 1 },
  { status: null },
  { signal: "SIGKILL" as const },
  { stderr: "warning" },
  { error: Object.assign(new Error("pipe failed"), { code: "EPIPE" }) },
])("does not trust a success receipt after abnormal process completion: %j", changes => {
  spawnSync.mockReturnValue(response('{"result":0,"errno":0}', changes));
  expect(() => renameDarwinNoReplace(input)).toThrowError(expect.objectContaining({
    code: "helper-failed", details: { commit: "unknown" },
  }));
});

it.each([
  "", "not-json", "null", "[]", "1", "{}",
  '{"result":0}', '{"errno":0}', '{"result":0,"errno":0,"extra":true}',
  '{"result":0,"errno":1}', '{"result":-1,"errno":0}', '{"result":1,"errno":17}',
  '{"result":-1,"errno":"17"}', '{"result":-1,"errno":-17}', '{"result":-1,"errno":0.5}',
  '{"result":-1,"errno":2147483648}', '{"result":-1,"errno":2147483647}',
  '{"result":-1,"errno":17,"commit":"not-attempted"}',
])("rejects malformed or unrecognized reply as unknown: %s", stdout => {
  spawnSync.mockReturnValue(response(stdout));
  expect(() => renameDarwinNoReplace(input)).toThrowError(expect.objectContaining({
    code: "helper-failed", details: { commit: "unknown" },
  }));
});

it.each(["EEXIST", "ENOTEMPTY"] as const)("keeps a %s collision indeterminate after dispatch", code => {
  spawnSync.mockReturnValue(response(JSON.stringify({ result: -1, errno: constants.errno[code] })));
  expect(() => renameDarwinNoReplace(input)).toThrowError(expect.objectContaining({
    code: "already-exists", details: { commit: "unknown" },
    cause: expect.objectContaining({ code, errno: -constants.errno[code], syscall: "renameatx_np" }),
  }));
});

it.each([
  ["EACCES", "helper-failed"], ["EBADF", "helper-failed"], ["EBUSY", "helper-failed"],
  ["EEXIST", "already-exists"], ["EINVAL", "helper-unavailable"], ["EISDIR", "helper-failed"],
  ["ELOOP", "helper-failed"], ["EMLINK", "helper-failed"], ["ENAMETOOLONG", "helper-failed"],
  ["ENOENT", "helper-failed"], ["ENOSPC", "helper-failed"], ["ENOSYS", "helper-unavailable"],
  ["ENOTDIR", "helper-failed"], ["ENOTEMPTY", "already-exists"], ["ENOTSUP", "helper-unavailable"],
  ["EOPNOTSUPP", "helper-unavailable"], ["EPERM", "helper-failed"], ["EROFS", "helper-failed"],
  ["ETXTBSY", "helper-failed"], ["EXDEV", "helper-failed"],
] as const)("keeps ordinary syscall rejection %s indeterminate without retry", (code, expectedCode) => {
  const errno = constants.errno[code];
  const observedCode = code === "EOPNOTSUPP" && errno === constants.errno.ENOTSUP ? "ENOTSUP" : code;
  spawnSync.mockReturnValue(response(JSON.stringify({ result: -1, errno })));
  expect(() => renameDarwinNoReplace(input)).toThrowError(expect.objectContaining({
    code: expectedCode, details: { commit: "unknown" },
    cause: expect.objectContaining({ code: observedCode, errno: -errno, syscall: "renameatx_np" }),
  }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each(["EIO", "ETIMEDOUT"] as const)(
  "conservatively preserves unknown outcome for syscall %s", code => {
    spawnSync.mockReturnValue(response(JSON.stringify({ result: -1, errno: constants.errno[code] })));
    expect(() => renameDarwinNoReplace(input)).toThrowError(expect.objectContaining({
      code: "helper-failed", details: { commit: "unknown" },
      cause: expect.objectContaining({ code, errno: -constants.errno[code], syscall: "renameatx_np" }),
    }));
    expect(spawnSync).toHaveBeenCalledOnce();
  },
);

it("preserves an unrecognized syscall errno as unknown without retry", () => {
  expect(getSystemErrorName(-12345)).not.toMatch(/^E[A-Z0-9]+$/);
  spawnSync.mockReturnValue(response('{"result":-1,"errno":12345}'));
  expect(() => renameDarwinNoReplace(input)).toThrowError(expect.objectContaining({
    code: "helper-failed", details: { commit: "unknown" },
  }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.runIf(process.platform === "darwin").each([
  ["source\n'\"$()\\雪", "target\n'\"$()\\☃"],
  ["source-\ud800", "target-\udfff"],
  ["source-\udfff", "target-\ud800"],
])("atomically moves unreadable %j to %j and preserves a competing target", async (sourceName, targetName) => {
  const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  spawnSync.mockImplementation(real.spawnSync);
  const directory = await tempRoot("fs-safe-darwin-command-");
  const source = path.join(directory, sourceName);
  const target = path.join(directory, targetName);
  fs.writeFileSync(source, "original", { mode: 0o600 });
  fs.chmodSync(source, 0);
  const before = fs.lstatSync(source, { bigint: true });
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    renameDarwinNoReplace({ source: { parentFd: fd, basename: sourceName }, target: { parentFd: fd, basename: targetName } });
    expect(fs.existsSync(source)).toBe(false);
    const after = fs.lstatSync(target, { bigint: true });
    expect({ dev: after.dev, ino: after.ino, mode: after.mode }).toEqual({ dev: before.dev, ino: before.ino, mode: before.mode });
    fs.chmodSync(target, 0o600);
    expect(fs.readFileSync(target, "utf8")).toBe("original");

    fs.writeFileSync(source, "second source");
    const collisionSource = fs.lstatSync(source, { bigint: true });
    expect(() => renameDarwinNoReplace({
      source: { parentFd: fd, basename: sourceName }, target: { parentFd: fd, basename: targetName },
    })).toThrowError(expect.objectContaining({ code: "already-exists", details: { commit: "unknown" } }));
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    expect(fs.lstatSync(source, { bigint: true }).ino).toBe(collisionSource.ino);
    expect(fs.readFileSync(source, "utf8")).toBe("second source");
  } finally {
    fs.closeSync(fd);
    if (fs.existsSync(source)) fs.chmodSync(source, 0o600);
    if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
  }
});
