import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RootMoveCommandInput } from "../src/root-move-command.js";
import { moveWindowsMetadataNoReplaceSync } from "../src/windows-move-command.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawnSync: vi.fn(),
}));

const sourceIdentity = "00000001:0020000000000001";
function input(): RootMoveCommandInput {
  return {
    root: { path: "C:\\scope", identity: { dev: 1n, ino: 2n } },
    source: { parentFd: 71, parentPath: "C:\\scope\\in", parentRelativePath: "in", parentIdentity: { dev: 1n, ino: 3n }, basename: "source", identity: { dev: 1n, ino: 0x20_0000_0000_0001n } },
    target: { parentFd: 72, parentPath: "C:\\scope\\out", parentRelativePath: "out", parentIdentity: { dev: 1n, ino: 4n }, basename: "target" },
  };
}
function receipt(overrides: Record<string, unknown> = {}) {
  return { ok: true, phase: "complete", commit: "committed", sourceIdentity, targetIdentity: sourceIdentity,
    code: null, message: null, ntStatus: 0, cleanupError: null, ...overrides };
}
function reply(value: unknown, extra: Record<string, unknown> = {}) {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, stdout: JSON.stringify(value), stderr: "", ...extra } as ReturnType<typeof spawnSync>);
}

beforeEach(() => { vi.clearAllMocks(); reply(receipt()); });
afterEach(() => { vi.restoreAllMocks(); });

it("sends exact identities and literal Unicode names without borrowing parent fds", () => {
  const request = input();
  request.target.basename = "é-☃-'$(literal)";
  moveWindowsMetadataNoReplaceSync(request);
  expect(spawnSync).toHaveBeenCalledOnce();
  const [file, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
  expect(file).toMatch(/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  expect(options).toMatchObject({ stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  expect(String(options!.input)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  const data = JSON.parse(Buffer.from(String(options!.input), "base64").toString("utf8"));
  expect(data).toMatchObject({ sourceIdentity, targetName: request.target.basename, rootIdentity: "00000001:0000000000000002" });
  expect(Object.keys(data).some(key => /fd/i.test(key))).toBe(false);
  expect((args as string[]).join(" ")).not.toContain(request.target.basename);
  expect((args as string[]).join(" ").length).toBeLessThan(30_000);
});

it("carries combined long paths on stdin instead of the command line or environment", () => {
  const request = input();
  request.root.path = "\\\\?\\C:\\" + "segment\\".repeat(1500) + "root";
  request.source.parentPath = request.root.path + "\\in";
  request.target.parentPath = request.root.path + "\\out";
  moveWindowsMetadataNoReplaceSync(request);
  const [, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
  expect(String(options!.input).length).toBeGreaterThan(32767);
  expect(options).not.toHaveProperty("env");
  expect((args as string[]).join(" ").length).toBeLessThan(30_000);
  expect(JSON.parse(Buffer.from(String(options!.input), "base64").toString("utf8")).rootPath).toBe(request.root.path);
});

it("rejects an over-budget request before starting the command", () => {
  const request = input(); request.target.basename = "a".repeat(800_000);
  expect(() => moveWindowsMetadataNoReplaceSync(request)).toThrow(expect.objectContaining({ code: "invalid-path" }));
  expect(spawnSync).not.toHaveBeenCalled();
});

it.runIf(process.platform === "win32")("rejects malformed UTF-8 before interpreting request fields", () => {
  moveWindowsMetadataNoReplaceSync(input());
  const [file, args] = vi.mocked(spawnSync).mock.calls[0]!;
  const run = (bytes: Buffer) => execFileSync(file, args as string[], {
    input: bytes.toString("base64"), encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  // Valid JSON with bad identity fields reaches the C# admission response.
  expect(JSON.parse(run(Buffer.from('{"sourceIdentity":"invalid"}')).trim())).toMatchObject({ ok: false, phase: "admission" });
  const malformed = Buffer.concat([Buffer.from('{"sourceIdentity":"invalid'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')]);
  // A replacement decoder would turn this into valid JSON and exit zero.
  expect(() => run(malformed)).toThrow(expect.objectContaining({ status: 1 }));
}, 65_000);

it.each([0n, -1n, 0x1_0000_0000n, 1.25, Number.MAX_SAFE_INTEGER + 1])("rejects invalid volume identity %s before dispatch", dev => {
  const request = input(); request.root.identity = { dev, ino: 2n } as RootMoveCommandInput["root"]["identity"];
  expect(() => moveWindowsMetadataNoReplaceSync(request)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(spawnSync).not.toHaveBeenCalled();
});

it.each(["", ".", "..", "nested/target", "nested\\target", "target:stream", "target.", "target "])("rejects invalid leaf %j before dispatch", basename => {
  const request = input(); request.target.basename = basename;
  expect(() => moveWindowsMetadataNoReplaceSync(request)).toThrow(expect.objectContaining({ code: "invalid-path" }));
  expect(spawnSync).not.toHaveBeenCalled();
});

it("rejects a relative-parent escape before dispatch", () => {
  const request = input(); request.source.parentRelativePath = "..\\outside";
  expect(() => moveWindowsMetadataNoReplaceSync(request)).toThrow(expect.objectContaining({ code: "invalid-path" }));
  expect(spawnSync).not.toHaveBeenCalled();
});

it.each([
  null, {}, { ok: true }, receipt({ sourceIdentity: "rounded" }), receipt({ targetIdentity: null }),
  receipt({ commit: "not-attempted" }), receipt({ ntStatus: -1 }), receipt({ ntStatus: 0x8000_0000 }),
  receipt({ cleanupError: "close failed" }), receipt({ code: "EIO" }), receipt({ message: "error" }),
  receipt({ ok: false, phase: "rename", commit: "committed", code: "EIO", message: "failure" }),
])("rejects malformed or contradictory receipts %j", value => {
  reply(value);
  expect(() => moveWindowsMetadataNoReplaceSync(input())).toThrow(expect.objectContaining({ code: "helper-failed", details: expect.objectContaining({ commit: "unknown" }) }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each([
  ["EIO", -1073741435], ["EPERM", -1073741790], ["ENOTSUP", -1073741637], ["EEXIST", -1073741771],
  ["EBUSY", -1073741757], ["ENOSPC", -1073741697], ["EINVAL", -1073741811],
] as const)("preserves actual rename %s without retry or collision inference", (code, ntStatus) => {
  reply(receipt({ ok: false, phase: "rename", commit: "unknown", targetIdentity: null, code, message: "actual NT operation failed", ntStatus }));
  expect(() => moveWindowsMetadataNoReplaceSync(input())).toThrow(expect.objectContaining({ code, phase: "rename", commit: "unknown", ntStatus }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each(["path-mismatch", "symlink", "hardlink", "not-file"])("preserves pre-mutation %s rejection", code => {
  reply(receipt({ ok: false, phase: "admission", commit: "not-attempted", targetIdentity: null, code, message: "admission rejected", ntStatus: null }));
  expect(() => moveWindowsMetadataNoReplaceSync(input())).toThrow(expect.objectContaining({ code, details: expect.objectContaining({ commit: "not-attempted" }) }));
});

it.each(["ENOENT", "EIO", "path-mismatch", "hardlink"])("retains committed state after verification %s", code => {
  reply(receipt({ ok: false, phase: "verification", targetIdentity: null, code, message: "post-commit observation failed" }));
  expect(() => moveWindowsMetadataNoReplaceSync(input())).toThrow(expect.objectContaining({
    code: "helper-failed", details: expect.objectContaining({ phase: "verification", commit: "committed" }), cause: expect.objectContaining({ code }),
  }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it("retains committed state and cleanup diagnostics after a handle-close failure", () => {
  reply(receipt({ ok: false, phase: "close", code: "EIO", message: "close failed", cleanupError: "close failed" }));
  expect(() => moveWindowsMetadataNoReplaceSync(input())).toThrow(expect.objectContaining({ code: "helper-failed", details: expect.objectContaining({ commit: "committed", cleanupError: "close failed" }) }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each([
  { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null },
  { status: 1 }, { signal: "SIGKILL" }, { stdout: "{" },
])("does not infer success from failed transport %j", transport => {
  reply(receipt(), transport);
  expect(() => moveWindowsMetadataNoReplaceSync(input())).toThrow(expect.objectContaining({ code: "helper-failed", details: expect.objectContaining({ commit: "unknown" }) }));
  expect(spawnSync).toHaveBeenCalledOnce();
});
