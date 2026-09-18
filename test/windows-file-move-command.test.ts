import { spawnSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { moveWindowsFileNoReplaceSync, type WindowsFileMoveCommandInput } from "../src/windows-move-command.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawnSync: vi.fn(),
}));

const sourceIdentity = "00000001:0020000000000001";
function input(): WindowsFileMoveCommandInput {
  return {
    source: { parentPath: "C:\\incoming", parentIdentity: { dev: 1n, ino: 2n }, basename: "source",
      identity: { dev: 1n, ino: 0x20_0000_0000_0001n }, expectedLinks: 3n },
    target: { parentPath: "C:\\unrelated\\outgoing", parentIdentity: { dev: 1n, ino: 3n }, basename: "target" },
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

it("carries independent parent receipts and exact preexisting links without a fabricated Root", () => {
  const request = input(); request.target.basename = "é-☃-'$(literal)";
  moveWindowsFileNoReplaceSync(request);
  expect(spawnSync).toHaveBeenCalledOnce();
  const [, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
  const wire = JSON.parse(Buffer.from(String(options!.input), "base64").toString("utf8"));
  expect(wire).toEqual({ scope: "parents", sourceParentPath: request.source.parentPath, sourceParentIdentity: "00000001:0000000000000002",
    sourceName: "source", sourceIdentity, expectedLinks: "3", targetParentPath: request.target.parentPath,
    targetParentIdentity: "00000001:0000000000000003", targetName: request.target.basename });
  expect(options).toMatchObject({ stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL" });
  expect((args as string[]).join(" ")).not.toContain(request.target.basename);
  expect((args as string[]).join(" ").length).toBeLessThan(30_000);
});

it.each([0n, -1n, 0x1_0000_0000n, 1, 1.25, Number.NaN])("rejects inexact or invalid link count %s before dispatch", links => {
  const request = input(); request.source.expectedLinks = links as bigint;
  expect(() => moveWindowsFileNoReplaceSync(request)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(spawnSync).not.toHaveBeenCalled();
});

it.each(["source", "target"] as const)("rejects a changed or unknown %s parent identity before dispatch", side => {
  const request = input(); request[side].parentIdentity.ino = 0n;
  expect(() => moveWindowsFileNoReplaceSync(request)).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(spawnSync).not.toHaveBeenCalled();
});

it.each(["../escape", "nested\\leaf", "target:stream", "target.", "target "])("rejects standalone leaf %j", basename => {
  const request = input(); request.target.basename = basename;
  expect(() => moveWindowsFileNoReplaceSync(request)).toThrow(expect.objectContaining({ code: "invalid-path" }));
  expect(spawnSync).not.toHaveBeenCalled();
});

it.each([-1073741771, -1073741567])("preserves a definite no-replace collision from NT status %s", ntStatus => {
  reply(receipt({ ok: false, phase: "rename", commit: "not-attempted", code: "EEXIST", message: "destination exists", ntStatus, targetIdentity: null }));
  expect(() => moveWindowsFileNoReplaceSync(input())).toThrow(expect.objectContaining({ code: "EEXIST", phase: "rename", commit: "not-attempted", ntStatus }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each([
  { code: "EIO", ntStatus: -1073741771 }, { code: "EEXIST", ntStatus: -1073741435 },
  { code: "EEXIST", ntStatus: null }, { code: "EEXIST", ntStatus: 0 },
])("rejects unsupported definitely-uncommitted claims %j", details => {
  reply(receipt({ ok: false, phase: "rename", commit: "not-attempted", message: "claimed collision", targetIdentity: null, ...details }));
  expect(() => moveWindowsFileNoReplaceSync(input())).toThrow(expect.objectContaining({ code: "helper-failed", details: expect.objectContaining({ commit: "unknown" }) }));
});

it("preserves a real dispatched I/O error as unknown without retry", () => {
  reply(receipt({ ok: false, phase: "rename", commit: "unknown", code: "EIO", message: "actual failure", ntStatus: -1073741435, targetIdentity: null }));
  expect(() => moveWindowsFileNoReplaceSync(input())).toThrow(expect.objectContaining({ code: "EIO", commit: "unknown" }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each(["verification", "close"])("preserves committed state after standalone %s failure", phase => {
  reply(receipt({ ok: false, phase, code: "EIO", message: "post-rename failure" }));
  expect(() => moveWindowsFileNoReplaceSync(input())).toThrow(expect.objectContaining({ code: "helper-failed", details: expect.objectContaining({ phase, commit: "committed" }) }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it("keeps transport uncertainty even when stdout contains a collision receipt", () => {
  reply(receipt({ ok: false, phase: "rename", commit: "not-attempted", code: "EEXIST", message: "collision", ntStatus: -1073741771, targetIdentity: null }), { status: 1 });
  expect(() => moveWindowsFileNoReplaceSync(input())).toThrow(expect.objectContaining({ code: "helper-failed", details: expect.objectContaining({ commit: "unknown" }) }));
  expect(spawnSync).toHaveBeenCalledOnce();
});
