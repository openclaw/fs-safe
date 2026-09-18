import { spawnSync } from "node:child_process";
import { getSystemErrorName } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import { renameDarwinNoReplace } from "../src/darwin-move-command.js";
import type { RootMoveCommandInput } from "../src/root-move-command.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawnSync: vi.fn(),
}));
vi.mock("node:util", async importOriginal => {
  const original = await importOriginal<typeof import("node:util")>();
  return { ...original, getSystemErrorName: vi.fn(original.getSystemErrorName) };
});
beforeEach(() => vi.clearAllMocks());

const identity = { dev: 1n, ino: 2n };
const input: RootMoveCommandInput = {
  root: { path: "/root", identity },
  source: { parentFd: 71, parentPath: "/root/incoming", parentRelativePath: "incoming", parentIdentity: identity, basename: "source-é-'\"-$;", identity },
  target: { parentFd: 72, parentPath: "/root/outgoing", parentRelativePath: "outgoing", parentIdentity: identity, basename: "target-é-'\"-$;" },
};

function reply(stdout: string, overrides: Record<string, unknown> = {}) {
  vi.mocked(spawnSync).mockReturnValue({
    status: 0, signal: null, pid: 1, output: [null, stdout, ""], stdout, stderr: "", ...overrides,
  } as ReturnType<typeof spawnSync>);
}

it("passes untrusted names only as JSON and inherits the admitted parent descriptors", () => {
  reply('{"result":0,"errno":0}');
  expect(renameDarwinNoReplace(input)).toBeUndefined();
  expect(spawnSync).toHaveBeenCalledOnce();
  const [file, argv, options] = vi.mocked(spawnSync).mock.calls[0]!;
  expect(file).toBe("/usr/bin/osascript");
  expect(argv?.slice(0, 3)).toEqual(["-l", "JavaScript", "-e"]);
  expect(argv?.[3]).not.toContain(input.source.basename);
  expect(options).toMatchObject({
    input: JSON.stringify({ sourceName: input.source.basename, targetName: input.target.basename }),
    stdio: ["pipe", "pipe", "pipe", 71, 72], encoding: "utf8", timeout: 30_000, maxBuffer: 65536,
  });
});

it("preserves an explicit atomic no-replace collision", () => {
  reply('{"result":-1,"errno":17}');
  // The command returns Darwin errno values even when this unit test runs elsewhere.
  if (process.platform !== "darwin") vi.mocked(getSystemErrorName).mockReturnValueOnce("EEXIST");
  expect(() => renameDarwinNoReplace(input)).toThrow(expect.objectContaining({ code: "EEXIST", errno: -17, syscall: "renameatx_np" }));
  expect(getSystemErrorName).toHaveBeenCalledExactlyOnceWith(-17);
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each([
  ["nonzero exit", { status: 1 }],
  ["signal", { status: null, signal: "SIGTERM" }],
  ["timeout", { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null }],
  ["stderr", { stderr: "unverified command diagnostic" }],
])("rejects a %s despite a success-shaped reply, without retry", (_name, overrides) => {
  reply('{"result":0,"errno":0}', overrides);
  expect(() => renameDarwinNoReplace(input)).toThrow(expect.objectContaining({ code: "helper-failed" }));
  expect(spawnSync).toHaveBeenCalledOnce();
});

it.each(["", "not JSON", "[]", "null", '{"result":0,"errno":17}', '{"result":-1,"errno":0}', '{"result":-1,"errno":1.5}', '{"result":-1,"errno":2147483648}'])(
  "rejects incomplete or inconsistent reply %s without retry", stdout => {
    reply(stdout);
    expect(() => renameDarwinNoReplace(input)).toThrow(expect.objectContaining({ code: "helper-failed" }));
    expect(spawnSync).toHaveBeenCalledOnce();
  },
);
