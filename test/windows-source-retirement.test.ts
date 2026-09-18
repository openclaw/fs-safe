import { spawnSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";
import { retireWindowsSourceNameSync, type WindowsSourceRetirementInput } from "../src/windows-source-retirement.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawnSync: vi.fn(),
}));
const id = "00000001:0020000000000001";
function input(): WindowsSourceRetirementInput {
  return { sourcePath: "C:\\scope\\source-é", sourceParentPath: "C:\\scope", sourceParentIdentity: { dev: 1n, ino: 2n }, identity: { dev: 1n, ino: 0x20_0000_0000_0001n }, expectedLinks: 2n };
}
function receipt(overrides: Record<string, unknown> = {}) {
  return { ok: true, phase: "complete", commit: "committed", sourceIdentity: id, expectedLinks: 2,
    remainingLinks: 1, readOnlyBefore: false, readOnlyAfter: false, windowsError: null, code: null, message: null, cleanupError: null, ...overrides };
}
function reply(result: unknown, extra: Record<string, unknown> = {}) {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, signal: null, stdout: JSON.stringify(result), stderr: "", ...extra } as ReturnType<typeof spawnSync>);
}
beforeEach(() => { vi.clearAllMocks(); reply(receipt()); });

it("sends exact source-name receipts without using the caller's descriptor", () => {
  retireWindowsSourceNameSync({ ...input(), sourceFd: 99 } as WindowsSourceRetirementInput);
  const [, args, options] = vi.mocked(spawnSync).mock.calls[0]!;
  expect(options).toMatchObject({ stdio: ["pipe", "pipe", "pipe"], timeout: 30_000, killSignal: "SIGKILL" });
  expect(String(options!.input)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  expect(JSON.parse(Buffer.from(String(options!.input), "base64").toString("utf8"))).toEqual({
    parentPath: "C:\\scope", parentIdentity: "00000001:0000000000000002", sourceName: "source-é", sourceIdentity: id, expectedLinks: 2,
  });
  expect((args as string[]).join(" ").length).toBeLessThan(32700);
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each([2n, 3n, 5n])("preserves surviving links when retiring one of %s names", expectedLinks => {
  reply(receipt({ expectedLinks: Number(expectedLinks), remainingLinks: Number(expectedLinks - 1n) }));
  expect(() => retireWindowsSourceNameSync({ ...input(), expectedLinks })).not.toThrow();
});

it.each([0n, 1n, -1n, 0x1_0000_0000n])("rejects invalid current link count %s before dispatch", expectedLinks => {
  expect(() => retireWindowsSourceNameSync({ ...input(), expectedLinks })).toThrow(expect.objectContaining({ code: "invalid-path", details: expect.objectContaining({ commit: "not-attempted" }) }));
  expect(spawnSync).not.toHaveBeenCalled();
});

it("rejects an unassociated parent before dispatch", () => {
  expect(() => retireWindowsSourceNameSync({ ...input(), sourceParentPath: "C:\\other" })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
  expect(spawnSync).not.toHaveBeenCalled();
});

it.each([
  null, {}, receipt({ commit: {} }), receipt({ remainingLinks: 2 }), receipt({ sourceIdentity: "rounded" }),
  receipt({ expectedLinks: 3 }), receipt({ readOnlyAfter: true }), receipt({ readOnlyBefore: null }),
  receipt({ phase: "admission" }), receipt({ windowsError: 87 }), receipt({ cleanupError: "failed" }),
])("rejects incomplete or contradictory retirement receipt %j", value => {
  reply(value);
  expect(() => retireWindowsSourceNameSync(input())).toThrow(expect.objectContaining({ code: "helper-failed", details: expect.objectContaining({ commit: "unknown" }) }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it("retains not-attempted state for a substituted source", () => {
  reply(receipt({ ok: false, phase: "admission", commit: "not-attempted", remainingLinks: null, readOnlyAfter: null, code: "path-mismatch", message: "source changed" }));
  expect(() => retireWindowsSourceNameSync(input())).toThrow(expect.objectContaining({ code: "path-mismatch", details: expect.objectContaining({ commit: "not-attempted" }) }));
});

it.each([[1, "ENOTSUP"], [50, "ENOTSUP"], [87, "EINVAL"], [120, "ENOTSUP"], [5, "EPERM"], [32, "EBUSY"]] as const)(
  "preserves disposition failure %s/%s without retry", (windowsError, code) => {
    reply(receipt({ ok: false, phase: "delete", commit: "unknown", remainingLinks: null, readOnlyAfter: null, code, windowsError, message: "disposition failed" }));
    expect(() => retireWindowsSourceNameSync(input())).toThrow(expect.objectContaining({
      code: "helper-failed", cause: expect.objectContaining({ code }), details: expect.objectContaining({ phase: "delete", commit: "unknown", windowsError }),
    }));
    expect(spawnSync).toHaveBeenCalledOnce();
  },
);

it("does not claim retirement until the POSIX delete handle closes", () => {
  reply(receipt({ ok: false, phase: "close-delete", commit: "unknown", remainingLinks: null, readOnlyAfter: null, code: "EIO", message: "close failed" }));
  expect(() => retireWindowsSourceNameSync(input())).toThrow(expect.objectContaining({ details: expect.objectContaining({ commit: "unknown" }) }));
});

it.each(["verification", "close"])("retains committed state on a later %s failure", phase => {
  reply(receipt({ ok: false, phase, code: "EIO", message: "later failure" }));
  expect(() => retireWindowsSourceNameSync(input())).toThrow(expect.objectContaining({ code: "helper-failed", details: expect.objectContaining({ commit: "committed", phase }) }));
});

it.each([{ status: 1 }, { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null }, { stdout: "{" }])(
  "treats transport failure %j as indeterminate", failure => {
    reply(receipt(), failure);
    expect(() => retireWindowsSourceNameSync(input())).toThrow(expect.objectContaining({ details: expect.objectContaining({ commit: "unknown" }) }));
    expect(spawnSync).toHaveBeenCalledOnce();
  },
);
