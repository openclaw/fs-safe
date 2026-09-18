import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renameLinuxNoReplaceSync, type LinuxRenameNoReplaceInput } from "../src/linux-rename-command.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawnSync: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.restoreAllMocks(); });

const input: LinuxRenameNoReplaceInput = {
  source: { parentFd: 41, basename: "source-'\n-é-🦀-\ud800", parentIdentity: { dev: 11n, ino: 9007199254740993n }, identity: { dev: 11n, ino: 9007199254740997n }, links: 3n, fd: 43 },
  target: { parentFd: 42, basename: "target", parentIdentity: { dev: 11n, ino: 9007199254740995n } },
};
const succeeded = { phase: "rename", result: 0, errno: 0, code: null };
function response(value: unknown, overrides: object = {}) {
  return { pid: 1, output: [], stdout: JSON.stringify(value), stderr: "", status: 0, signal: null, ...overrides } as ReturnType<typeof spawnSync>;
}

it("transports exact identities and Node UTF-8 basenames through isolated Python with retained descriptors", () => {
  const spawn = vi.mocked(spawnSync).mockReturnValue(response(succeeded));
  const stat = vi.spyOn(fs, "fstatSync");
  renameLinuxNoReplaceSync(input);
  expect(spawn).toHaveBeenCalledOnce();
  const [command, argv, options] = spawn.mock.calls[0]!;
  expect(command).toBe("/usr/bin/python3");
  expect(argv!.slice(0, 5)).toEqual(["-I", "-S", "-X", "utf8", "-c"]);
  expect(argv![5]).not.toContain(input.source.basename);
  expect(options).toMatchObject({ cwd: "/", env: { LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe", 41, 42, 43], timeout: 30_000, maxBuffer: 65536 });
  expect(Object.keys(options!.env!)).toEqual(["LANG", "LC_ALL"]);
  expect(JSON.parse(String(options!.input))).toEqual({
    sourceName: Buffer.from(input.source.basename, "utf8").toString("base64"), targetName: Buffer.from("target").toString("base64"),
    sourceParent: { dev: "11", ino: "9007199254740993" }, targetParent: { dev: "11", ino: "9007199254740995" },
    source: { dev: "11", ino: "9007199254740997" }, links: "3", sourcePinned: true,
  });
  expect(stat).not.toHaveBeenCalled();
});

it("supports a caller without an additional source descriptor", () => {
  const spawn = vi.mocked(spawnSync).mockReturnValue(response(succeeded));
  renameLinuxNoReplaceSync({ ...input, source: { ...input.source, fd: undefined } });
  expect(spawn.mock.calls[0]![2]!.stdio).toEqual(["pipe", "pipe", "pipe", 41, 42]);
  expect(JSON.parse(String(spawn.mock.calls[0]![2]!.input)).sourcePinned).toBe(false);
});

it.each(["ENOENT", "EACCES", "ENOEXEC"])("reports definite process admission failure %s without an unknown mutation", code => {
  const error = Object.assign(new Error("spawn failed"), { code });
  const spawn = vi.mocked(spawnSync).mockReturnValue(response(null, { error, pid: 0, status: null, signal: null, output: null, stdout: undefined, stderr: undefined }));
  expect(() => renameLinuxNoReplaceSync(input)).toThrow(expect.objectContaining({ code: "helper-unavailable", cause: error, details: { commit: "not-attempted" } }));
  expect(spawn).toHaveBeenCalledOnce();
});

it.each(["ENOENT", "EACCES", "ENOEXEC"])("preserves uncertainty for %s reported after a child received a PID", code => {
  const error = Object.assign(new Error("pipe failed after spawn"), { code });
  const spawn = vi.mocked(spawnSync).mockReturnValue(response(succeeded, { error, pid: 123 }));
  expect(() => renameLinuxNoReplaceSync(input)).toThrow(expect.objectContaining({ code: "helper-failed", cause: error, details: { commit: "unknown" } }));
  expect(spawn).toHaveBeenCalledOnce();
});

it.each([
  { pid: 0, status: 0, signal: null },
  { pid: 0, status: null, signal: "SIGTERM" },
  { pid: undefined, status: null, signal: null },
  { pid: 123, status: null, signal: null },
])("does not infer startup failure from contradictory process metadata %j", metadata => {
  const error = Object.assign(new Error("unverified admission error"), { code: "EACCES" });
  const spawn = vi.mocked(spawnSync).mockReturnValue(response(succeeded, { error, ...metadata }));
  expect(() => renameLinuxNoReplaceSync(input)).toThrow(expect.objectContaining({ code: "helper-failed", cause: error, details: { commit: "unknown" } }));
  expect(spawn).toHaveBeenCalledOnce();
});

it.each([
  [{ phase: "prepare", error: "unavailable" }, "helper-unavailable", "not-attempted"],
  [{ phase: "prepare", error: "path-mismatch" }, "path-mismatch", "not-attempted"],
  [{ phase: "rename", result: -1, errno: 17, code: "EEXIST" }, "already-exists", "not-attempted"],
  [{ phase: "rename", result: -1, errno: 5, code: "EIO" }, "helper-failed", "unknown"],
] as const)("preserves the child outcome %j without retry", (reply, code, commit) => {
  const spawn = vi.mocked(spawnSync).mockReturnValue(response(reply));
  expect(() => renameLinuxNoReplaceSync(input)).toThrow(expect.objectContaining({ code, details: { commit } }));
  expect(spawn).toHaveBeenCalledOnce();
});

it.each([
  { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) },
  { status: 1 }, { signal: "SIGTERM" }, { stderr: "unexpected output" }, { stdout: "" },
  { stdout: "{}" }, { stdout: "[]" }, { stdout: "null" },
  { stdout: JSON.stringify({ phase: "rename", result: 0, errno: 5, code: "EIO" }) },
  { stdout: JSON.stringify({ phase: "prepare", error: "unavailable", result: 0 }) },
  { stdout: JSON.stringify({ ...succeeded, extra: true }) },
])("preserves uncertainty for incomplete or contradictory process replies: %j", overrides => {
  const spawn = vi.mocked(spawnSync).mockReturnValue(response(succeeded, overrides));
  expect(() => renameLinuxNoReplaceSync(input)).toThrow(expect.objectContaining({ code: "helper-failed", details: { commit: "unknown" } }));
  expect(spawn).toHaveBeenCalledOnce();
});
