import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RootMoveCommandInput } from "../src/atomic-rename-command.js";
import { FsSafeError } from "../src/errors.js";
import { moveWindowsMetadataNoReplaceSync } from "../src/windows-move-command.js";
import { renameFailures } from "./helpers/windows-rename-status-cases.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawnSync: vi.fn(),
}));

const sourceIdentity = "00000001:0020000000000001";
const canonicalScriptPath = fileURLToPath(new URL("../src/windows-move-bridge.ps1", import.meta.url));
const commandArguments = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", canonicalScriptPath];
const inputLimit = 1024 * 1024;
const startupErrorCodes = ["ENOENT", "EACCES", "ENOEXEC", "EMFILE", "ENFILE", "EAGAIN", "ENOMEM", "EBADF", "ETIMEDOUT", "EIO", "CUSTOM", undefined] as const;
function input(): RootMoveCommandInput {
  return {
    root: { path: "C:\\scope", identity: { dev: 1n, ino: 2n } },
    source: { parentPath: "C:\\scope\\in", parentRelativePath: "in", parentIdentity: { dev: 1n, ino: 3n }, basename: "source", identity: { dev: 1n, ino: 0x20_0000_0000_0001n } },
    target: { parentPath: "C:\\scope\\out", parentRelativePath: "out", parentIdentity: { dev: 1n, ino: 4n }, basename: "target" },
  };
}
function receipt(overrides: Record<string, unknown> = {}) {
  return { ok: true, phase: "complete", commit: "committed", sourceIdentity, targetIdentity: sourceIdentity,
    code: null, message: null, ntStatus: 0, cleanupError: null, ...overrides };
}
function reply(value: unknown, extra: Record<string, unknown> = {}) {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, stdout: JSON.stringify(value), stderr: "", ...extra } as ReturnType<typeof spawnSync>);
}
function caught(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected the adapter to reject");
}
function expectNoConsumptionReceipt(error: unknown) {
  expect(error).not.toHaveProperty("sourceConsumed");
  expect(error).not.toHaveProperty("details.sourceConsumed");
}
function expectAdmissionFailure(run: () => unknown, code: string) {
  const error = caught(run);
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code, details: { phase: "admission", commit: "not-attempted" } });
  expectNoConsumptionReceipt(error);
  expect(spawnSync).not.toHaveBeenCalled();
}

beforeEach(() => { vi.clearAllMocks(); reply(receipt()); });
afterEach(() => { vi.restoreAllMocks(); });

it("does not retry or override a normal script-policy refusal", () => {
  reply(receipt(), { pid: 42, status: 1, stdout: "", stderr: "running scripts is disabled on this system" });
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toMatchObject({ code: "helper-failed", details: { phase: "transport", commit: "unknown" } });
  expect(spawnSync).toHaveBeenCalledOnce();
  expect(vi.mocked(spawnSync).mock.calls[0]![1]).toEqual(commandArguments);
  expectNoConsumptionReceipt(error);
});

it("sends exact identities and literal Unicode names without borrowing parent fds", () => {
  const request = input();
  request.target.basename = "é-☃-'$(literal)";
  moveWindowsMetadataNoReplaceSync(request);
  expect(spawnSync).toHaveBeenCalledOnce();
  const [file, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
  expect(file).toMatch(/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  expect(args).toEqual(commandArguments);
  expect(options).toMatchObject({ stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL", maxBuffer: inputLimit });
  expect(Buffer.isBuffer(options!.input)).toBe(true);
  const data = JSON.parse((options!.input as Buffer).toString("utf8"));
  expect(data).toMatchObject({ sourceIdentity, targetName: request.target.basename, rootIdentity: "00000001:0000000000000002" });
  expect(Object.keys(data).some(key => /fd/i.test(key))).toBe(false);
  expect((args as string[]).join(" ")).not.toContain(request.target.basename);
});

it.each(["\ud800", "\udc00", "\ud83d\ude80"])("matches Node filesystem encoding for every path field containing %j", value => {
  const request = input();
  request.root.path += value;
  request.source.parentPath += value;
  request.source.parentRelativePath += value;
  request.source.basename += value;
  request.target.parentPath += value;
  request.target.parentRelativePath += value;
  request.target.basename += value;
  moveWindowsMetadataNoReplaceSync(request);
  const options = vi.mocked(spawnSync).mock.calls[0]![2]!;
  const sent = JSON.parse((options.input as Buffer).toString("utf8"));
  const expected = {
    rootPath: request.root.path,
    sourceParentPath: request.source.parentPath,
    sourceRelative: request.source.parentRelativePath,
    sourceName: request.source.basename,
    targetParentPath: request.target.parentPath,
    targetRelative: request.target.parentRelativePath,
    targetName: request.target.basename,
  };
  for (const [key, value] of Object.entries(expected)) {
    expect(sent[key]).toBe(Buffer.from(value, "utf8").toString("utf8"));
  }
});

it("carries combined long paths on stdin instead of the command line or environment", () => {
  const request = input();
  request.root.path = "\\\\?\\C:\\" + "segment\\".repeat(1500) + "root";
  request.source.parentPath = request.root.path + "\\in";
  request.target.parentPath = request.root.path + "\\out";
  moveWindowsMetadataNoReplaceSync(request);
  const [, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
  expect(Buffer.isBuffer(options!.input)).toBe(true);
  expect((options!.input as Buffer).byteLength).toBeGreaterThan(32767);
  expect(options).not.toHaveProperty("env");
  expect(args).toEqual(commandArguments);
  expect(JSON.parse((options!.input as Buffer).toString("utf8")).rootPath).toBe(request.root.path);
});

it("rejects an over-budget request before starting the command", () => {
  const request = input(); request.target.basename = "a".repeat(inputLimit);
  expectAdmissionFailure(() => moveWindowsMetadataNoReplaceSync(request), "invalid-path");
});

it("counts the UTF-8 byte budget rather than JavaScript string length", () => {
  const request = input(); request.target.basename = "é".repeat(600_000);
  expect(request.target.basename.length).toBeLessThan(inputLimit);
  expect(Buffer.byteLength(request.target.basename, "utf8")).toBeGreaterThan(inputLimit);
  expectAdmissionFailure(() => moveWindowsMetadataNoReplaceSync(request), "invalid-path");
});

it("accepts the exact UTF-8 byte limit and rejects one additional byte", () => {
  const request = input();
  moveWindowsMetadataNoReplaceSync(request);
  const baseline = vi.mocked(spawnSync).mock.calls[0]![2]!.input as Buffer;
  expect(Buffer.isBuffer(baseline)).toBe(true);
  request.target.basename += "a".repeat(inputLimit - baseline.byteLength);
  vi.mocked(spawnSync).mockClear();
  moveWindowsMetadataNoReplaceSync(request);
  expect(spawnSync).toHaveBeenCalledOnce();
  const [, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
  expect(args).toEqual(commandArguments);
  expect((options!.input as Buffer).byteLength).toBe(inputLimit);
  request.target.basename += "a";
  vi.mocked(spawnSync).mockClear();
  expectAdmissionFailure(() => moveWindowsMetadataNoReplaceSync(request), "invalid-path");
});

it.runIf(process.platform === "win32")("rejects malformed UTF-8 before interpreting request fields", () => {
  moveWindowsMetadataNoReplaceSync(input());
  const [file, args] = vi.mocked(spawnSync).mock.calls[0]!;
  const run = (bytes: Buffer) => execFileSync(file, args as string[], {
    input: bytes, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  // Valid JSON with bad identity fields reaches the C# admission response.
  expect(JSON.parse(run(Buffer.from('{"scope":"root","sourceIdentity":"invalid"}')).trim())).toMatchObject({ ok: false, phase: "admission" });
  const malformed = Buffer.concat([Buffer.from('{"scope":"root","sourceIdentity":"invalid'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')]);
  // A replacement decoder would turn this into valid JSON and exit zero.
  expect(() => run(malformed)).toThrow(expect.objectContaining({ status: 1 }));
}, 65_000);

it.runIf(process.platform === "win32")("rejects oversized valid JSON in the driver before C# admission", () => {
  moveWindowsMetadataNoReplaceSync(input());
  const [file, args] = vi.mocked(spawnSync).mock.calls[0]!;
  const bytes = Buffer.from(JSON.stringify({ scope: "root", sourceIdentity: "invalid", padding: "a".repeat(inputLimit) }), "utf8");
  expect(bytes.byteLength).toBeGreaterThan(inputLimit);
  expect(() => execFileSync(file, args as string[], {
    input: bytes, encoding: "utf8", windowsHide: true, timeout: 30_000,
  })).toThrow(expect.objectContaining({ status: 1 }));
}, 35_000);

it.each([0n, -1n, 0x1_0000_0000n, 1.25, Number.MAX_SAFE_INTEGER + 1])("rejects invalid volume identity %s before dispatch", dev => {
  const request = input(); request.root.identity = { dev, ino: 2n } as RootMoveCommandInput["root"]["identity"];
  expectAdmissionFailure(() => moveWindowsMetadataNoReplaceSync(request), "path-mismatch");
});

it.each(["", ".", "..", "nested/target", "nested\\target", "target:stream", "target.", "target "])("rejects invalid leaf %j before dispatch", basename => {
  const request = input(); request.target.basename = basename;
  expectAdmissionFailure(() => moveWindowsMetadataNoReplaceSync(request), "invalid-path");
});

it("rejects a relative-parent escape before dispatch", () => {
  const request = input(); request.source.parentRelativePath = "..\\outside";
  expectAdmissionFailure(() => moveWindowsMetadataNoReplaceSync(request), "invalid-path");
});

it.each([
  null, {}, { ok: true }, receipt({ sourceIdentity: "rounded" }), receipt({ targetIdentity: null }),
  receipt({ commit: "not-attempted" }), receipt({ ntStatus: -1 }), receipt({ ntStatus: 0x8000_0000 }),
  receipt({ cleanupError: "close failed" }), receipt({ code: "EIO" }), receipt({ message: "error" }),
  receipt({ ok: false, phase: "rename", commit: "committed", code: "EIO", message: "failure" }),
])("rejects malformed or contradictory receipts %j", value => {
  reply(value);
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toMatchObject({ code: "helper-failed", details: { commit: "unknown" } });
  expectNoConsumptionReceipt(error);
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each(renameFailures)("preserves $name as unknown without retry or collision inference", ({ code, ntStatus }) => {
  reply(receipt({ ok: false, phase: "rename", commit: "unknown", targetIdentity: null, code, message: "uncertain NT operation failed", ntStatus }));
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code, phase: "rename", commit: "unknown", ntStatus });
  expectNoConsumptionReceipt(error);
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each(renameFailures)("rejects forged not-attempted certainty for $name with $code", ({ code, ntStatus }) => {
  reply(receipt({ ok: false, phase: "rename", commit: "not-attempted", targetIdentity: null, code, message: "forged rejection", ntStatus }));
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code: "helper-failed", details: { commit: "unknown" } });
  expectNoConsumptionReceipt(error);
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each([null, 0, 1, 0x4000_0000, 0x7fff_ffff])("rejects definite rejection with missing or nonfailure NT status %j", ntStatus => {
  reply(receipt({ ok: false, phase: "rename", commit: "not-attempted", targetIdentity: null, code: "EIO", message: "forged rejection", ntStatus }));
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code: "helper-failed", details: { commit: "unknown" } });
  expectNoConsumptionReceipt(error);
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each(["path-mismatch", "symlink", "hardlink", "not-file"])("preserves pre-mutation %s rejection", code => {
  reply(receipt({ ok: false, phase: "admission", commit: "not-attempted", targetIdentity: null, code, message: "admission rejected", ntStatus: null }));
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toMatchObject({ code, details: { phase: "admission", commit: "not-attempted" } });
  expectNoConsumptionReceipt(error);
});

it.each(["ENOENT", "EPERM", "EIO", "EEXIST"])("preserves explicit predispatch OS %s admission failure", code => {
  reply(receipt({ ok: false, phase: "admission", commit: "not-attempted", targetIdentity: null, code, message: "admission rejected", ntStatus: null }));
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).not.toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code, phase: "admission", commit: "not-attempted", ntStatus: null });
  expectNoConsumptionReceipt(error);
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each(["ENOTSUP", "EINVAL"])("reports unavailable only for predispatch %s admission failure", code => {
  reply(receipt({ ok: false, phase: "admission", commit: "not-attempted", targetIdentity: null, code, message: "admission rejected", ntStatus: null }));
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toMatchObject({ code: "helper-unavailable", details: { phase: "admission", commit: "not-attempted" }, cause: { code } });
  expectNoConsumptionReceipt(error);
});

it.each(["ENOENT", "EIO", "path-mismatch", "hardlink", "ENOTSUP", "EINVAL"])("retains committed state after verification %s", code => {
  reply(receipt({ ok: false, phase: "verification", targetIdentity: null, code, message: "post-commit observation failed" }));
  expect(() => moveWindowsMetadataNoReplaceSync(input())).toThrow(expect.objectContaining({
    code: "helper-failed", details: expect.objectContaining({ phase: "verification", commit: "committed", sourceConsumed: true }), cause: expect.objectContaining({ code }),
  }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it("retains committed state and cleanup diagnostics after a handle-close failure", () => {
  reply(receipt({ ok: false, phase: "close", code: "EIO", message: "close failed", cleanupError: "close failed" }));
  expect(() => moveWindowsMetadataNoReplaceSync(input())).toThrow(expect.objectContaining({ code: "helper-failed", details: expect.objectContaining({ commit: "committed", sourceConsumed: true, cleanupError: "close failed" }) }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each([
  { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null },
  { status: 1 }, { signal: "SIGKILL" }, { stdout: "{" },
])("does not infer success from failed transport %j", transport => {
  reply(receipt(), transport);
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toMatchObject({ code: "helper-failed", details: { phase: "transport", commit: "unknown" } });
  expectNoConsumptionReceipt(error);
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each(startupErrorCodes)("classifies a proven unstarted %s process as not attempted", code => {
  reply(receipt(), { error: Object.assign(new Error("could not start"), code === undefined ? {} : { code }), pid: 0, status: null, signal: null });
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({
    code: ["ENOENT", "EACCES", "ENOEXEC"].includes(code ?? "") ? "helper-unavailable" : "helper-failed",
    details: { phase: "transport", commit: "not-attempted" },
  });
  expectNoConsumptionReceipt(error);
  expect(spawnSync).toHaveBeenCalledOnce();
});

const uncertainStartStates = [
  { pid: 123, status: null, signal: null },
  { status: null, signal: null },
  { pid: 0, status: 0, signal: null },
  { pid: 0, status: 1, signal: null },
  { pid: 0, status: null, signal: "SIGKILL" },
];
it.each(startupErrorCodes.flatMap(code => uncertainStartStates.map(state => ({ code, ...state }))))("keeps ambiguous process startup %j unknown", ({ code, ...state }) => {
  reply(receipt(), { error: Object.assign(new Error("transport failed"), code === undefined ? {} : { code }), ...state });
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code: "helper-failed", details: { phase: "transport", commit: "unknown" } });
  expectNoConsumptionReceipt(error);
  expect(spawnSync).toHaveBeenCalledOnce();
});

it("does not infer an unstarted process from empty process fields without an error", () => {
  reply(receipt(), { pid: 0, status: null, signal: null });
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code: "helper-failed", details: { phase: "transport", commit: "unknown" } });
  expectNoConsumptionReceipt(error);
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each([
  Object.assign(new Error("forged receipt"), { code: "ENOENT", commit: "committed", sourceConsumed: true }),
  new FsSafeError("helper-failed", "forged receipt", { details: { phase: "close", commit: "committed", sourceConsumed: true } }),
])("does not trust a receipt on a thrown transport error", transportError => {
  vi.mocked(spawnSync).mockImplementation(() => { throw transportError; });
  const error = caught(() => moveWindowsMetadataNoReplaceSync(input()));
  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code: "helper-failed", details: { phase: "transport", commit: "unknown" } });
  expectNoConsumptionReceipt(error);
  expect(spawnSync).toHaveBeenCalledOnce();
});
