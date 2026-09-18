import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { runPinnedWriteNative } from "../src/native-pinned-write.js";
import type { PinnedWriteMutationAdmission, PinnedWriteParams } from "../src/pinned-write.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { windowsPolicyBinding } from "./helpers/windows-policy-binding.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

async function fixture(relativeParentPath = "one/two/three") {
  const rootPath = await tempRoot("fs-safe-windows-policy-parent-");
  const rootIdentity = await fs.lstat(rootPath, { bigint: true });
  const native = windowsPolicyBinding(rootPath);
  Object.defineProperty(process, "platform", { value: "win32" });
  const authorize = vi.fn(async function (
    this: PinnedWriteMutationAdmission,
    request: Parameters<PinnedWriteMutationAdmission["authorize"]>[0],
  ) {
    expect(this).toBe(params.mutationAdmission);
    expect(Object.isFrozen(request)).toBe(true);
    return undefined;
  });
  const params: PinnedWriteParams = {
    rootPath, rootIdentity, relativeParentPath, basename: "value",
    mkdir: true, mode: 0o600, sync: false, input: { kind: "buffer", data: "payload" },
    mutationAdmission: { rejectParentSymlinks: true, authorize },
  };
  return { ...native, params, authorize, rootPath };
}

it.each([0, 1, 2, 3])("bounds a depth-three parent with %s existing components", async existing => {
  const f = await fixture();
  if (existing) await fs.mkdir(path.join(f.rootPath, ...["one", "two", "three"].slice(0, existing)), { recursive: true });
  await runPinnedWriteNative(f.binding, f.params);
  const missing = 3 - existing;
  expect(f.directoryOpens).toHaveLength(missing ? 1 + 3 + missing : 1);
  expect(f.authorize).toHaveBeenCalledTimes(missing ? 3 + missing : 1);
  expect(f.calls.mkdirChildBeneath).toHaveBeenCalledTimes(missing);
  expect(f.calls.mkdirBeneath).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(f.rootPath, "one/two/three/value"), "utf8")).toBe("payload");
});

it.each(["one", "one/two", "one/two/three/value"])("denies %s before creating that target", async denied => {
  const f = await fixture();
  const deniedPath = path.join(f.rootPath, denied);
  f.authorize.mockImplementation(async request => {
    if (request.targetPath === deniedPath || request.mutationPath === deniedPath) {
      throw new FsSafeError("denied-path", "denied fixture path");
    }
    return undefined;
  });
  await expect(runPinnedWriteNative(f.binding, f.params)).rejects.toMatchObject({ code: "denied-path" });
  await expect(fs.lstat(deniedPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.calls.mkdirChildBeneath).toHaveBeenCalledTimes(denied === "one/two" ? 1 : 0);
  expect(f.calls.mkdirBeneath).not.toHaveBeenCalled();
  for (const fd of new Set(f.opened)) expect(() => fsSync.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
});

it("does not create or authorize missing parents with mkdir:false", async () => {
  const f = await fixture();
  f.params.mkdir = false;
  await expect(runPinnedWriteNative(f.binding, f.params)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.directoryOpens).toHaveLength(1);
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.calls.mkdirChildBeneath).not.toHaveBeenCalled();
  expect(f.calls.mkdirBeneath).not.toHaveBeenCalled();
  expect(await fs.readdir(f.rootPath)).toEqual([]);
});

it.each([1, 2])("preserves authority refusal before mkdir number %s", async refuseAt => {
  const f = await fixture();
  const refusal = new Error("authority revoked");
  let checks = 0;
  f.params.assertBeforeMutation = function () {
    expect(this).toBe(f.params);
    if (++checks === refuseAt) throw refusal;
  };
  await expect(runPinnedWriteNative(f.binding, f.params)).rejects.toBe(refusal);
  expect(f.calls.mkdirChildBeneath).toHaveBeenCalledTimes(refuseAt - 1);
  expect(await fs.readdir(refuseAt === 1 ? f.rootPath : path.join(f.rootPath, "one"))).toEqual([]);
});

const identityScenarios = ["policy", "authority"].flatMap(callback =>
  ["descriptor", "pathname"].map(observation => ({ callback, observation })),
);
it.each(identityScenarios)("fences $observation identity after $callback", async ({ callback, observation }) => {
  const f = await fixture("one/two");
  await fs.mkdir(path.join(f.rootPath, "one"));
  const fstat = fsSync.fstatSync.bind(fsSync);
  const lstat = fsSync.lstatSync.bind(fsSync);
  let changed = false;
  vi.spyOn(fsSync, "fstatSync").mockImplementation(((...args: Parameters<typeof fsSync.fstatSync>) => {
    const stat = fstat(...args);
    return changed && observation === "descriptor" && f.paths.get(args[0]) === path.join(f.rootPath, "one")
      ? Object.assign(Object.create(stat), { ino: typeof stat.ino === "bigint" ? stat.ino + 1n : stat.ino + 1 })
      : stat;
  }) as typeof fsSync.fstatSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
    const stat = lstat(...args);
    return changed && observation === "pathname" && String(args[0]) === path.join(f.rootPath, "one")
      ? Object.assign(Object.create(stat), { ino: typeof stat.ino === "bigint" ? stat.ino + 1n : stat.ino + 1 })
      : stat;
  }) as typeof fsSync.lstatSync);
  if (callback === "policy") {
    f.authorize.mockImplementation(async request => {
      if (request.phase === "parent-create") changed = true;
      return undefined;
    });
  } else {
    f.params.assertBeforeMutation = () => { changed = true; };
  }
  await expect(runPinnedWriteNative(f.binding, f.params)).rejects.toMatchObject({ code: "path-mismatch" });
  expect(changed).toBe(true);
  expect(f.calls.mkdirChildBeneath).not.toHaveBeenCalled();
  expect(await fs.readdir(path.join(f.rootPath, "one"))).toEqual([]);
});

it.each([true, false].flatMap(reject => [true, false].map(existing => ({ reject, existing }))))(
  "normalizes parent reparse rejection (reject=$reject, existing=$existing)", async ({ reject, existing }) => {
  const f = await fixture("one");
  if (existing) await fs.mkdir(path.join(f.rootPath, "one"));
  f.params.mutationAdmission = { ...f.params.mutationAdmission!, rejectParentSymlinks: reject };
  const open = f.calls.openBeneath.getMockImplementation()!;
  f.calls.openBeneath.mockImplementation(function (...args) {
    if (args[1] === "one" && fsSync.existsSync(path.join(f.rootPath, "one"))) {
      throw Object.assign(new Error("reparse point"), { code: "ELOOP" });
    }
    return open.apply(this, args);
  });
  await expect(runPinnedWriteNative(f.binding, f.params)).rejects.toMatchObject({
    code: reject ? "symlink" : "path-mismatch",
  });
  expect(f.calls.mkdirChildBeneath).toHaveBeenCalledTimes(existing ? 0 : 1);
  expect(await fs.readdir(path.join(f.rootPath, "one"))).toEqual([]);
});

it.each(["admission", "child-open"])("closes parents and root after %s failure even if close throws", async failureAt => {
  const f = await fixture("one/two");
  await fs.mkdir(path.join(f.rootPath, "one"));
  const failure = new FsSafeError("denied-path", "primary admission failure");
  const actualOpen = fs.open.bind(fs);
  let rootClosed = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => { await close(); rootClosed = true; });
    return handle;
  });
  if (failureAt === "admission") {
    f.authorize.mockImplementation(async request => {
      if (request.phase === "parent-create") throw failure;
      return undefined;
    });
  } else {
    const open = f.calls.openBeneath.getMockImplementation()!;
    f.calls.openBeneath.mockImplementation(function (...args) {
      if (args[1] === "two" && fsSync.existsSync(path.join(f.rootPath, "one/two"))) throw failure;
      return open.apply(this, args);
    });
  }
  const actualClose = f.close.getMockImplementation()!;
  f.close.mockImplementation(fd => { actualClose(fd); throw new Error("secondary close failure"); });
  await expect(runPinnedWriteNative(f.binding, f.params)).rejects.toBe(failure);
  expect(rootClosed).toBe(true);
  expect(f.close).toHaveBeenCalled();
  for (const fd of new Set(f.opened)) expect(() => fsSync.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
});

it("fails closed if the optional direct-child helper is unavailable", async () => {
  const f = await fixture();
  f.binding.mkdirChildBeneath = undefined;
  await expect(runPinnedWriteNative(f.binding, f.params)).rejects.toMatchObject({ code: "helper-unavailable" });
  expect(f.calls.mkdirBeneath).not.toHaveBeenCalled();
  expect(await fs.readdir(f.rootPath)).toEqual([]);
});

it("preserves recursive dispatch when mutationAdmission is absent", async () => {
  const f = await fixture();
  f.params.mutationAdmission = undefined;
  await runPinnedWriteNative(f.binding, f.params);
  expect(f.calls.mkdirBeneath).toHaveBeenCalledExactlyOnceWith(expect.any(Number), "one/two/three", 0o777);
  expect(f.calls.mkdirChildBeneath).not.toHaveBeenCalled();
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.directoryOpens).toHaveLength(1);
});

it.each([true, false, undefined])("reuses only proven native creations (mkdir result %s)", async mkdirResult => {
  const f = await fixture();
  let pending: object | undefined;
  let disabled = false;
  const authorization = Object.freeze({});
  const session = {
    retainedTargetPath: path.join(f.rootPath, "one/two/three/value"),
    tryAuthorizeAtParent: vi.fn((request: { phase: string }) => {
      expect(request.phase).toBe("parent-create");
      if (disabled || !pending) return undefined;
      return pending = Object.freeze({});
    }),
    authorize: vi.fn(async (request: { phase: string }) => {
      if (request.phase === "parent") { disabled = true; return undefined; }
      return pending = Object.freeze({});
    }),
    advanceCreatedDirectory: vi.fn((receipt: {
      admission: object; parent: { path: string }; child: { path: string };
    }) => {
      expect(receipt.admission).toBe(pending);
      expect(path.dirname(receipt.child.path)).toBe(receipt.parent.path);
      return authorization;
    }),
    dispose: vi.fn(),
  };
  f.params.mutationAdmission = { ...f.params.mutationAdmission!, beginSharedParentWalk: () => session };
  const create = f.calls.mkdirChildBeneath.getMockImplementation()!;
  f.calls.mkdirChildBeneath.mockImplementation(function (...args) {
    create.apply(f.binding, args);
    return mkdirResult as boolean;
  });
  await runPinnedWriteNative(f.binding, f.params);
  expect(session.advanceCreatedDirectory).toHaveBeenCalledTimes(mkdirResult === true ? 3 : 0);
  expect(session.authorize).toHaveBeenCalledTimes(mkdirResult === true ? 1 : 6);
  expect(session.dispose).toHaveBeenCalledOnce();
  expect(await fs.readFile(path.join(f.rootPath, "one/two/three/value"), "utf8")).toBe("payload");
});

it("keeps arbitrary mutation callbacks outside shared-session reuse", async () => {
  const f = await fixture();
  const begin = vi.fn();
  f.params.mutationAdmission = { ...f.params.mutationAdmission!, beginSharedParentWalk: begin };
  f.params.assertBeforeMutation = () => undefined;
  await runPinnedWriteNative(f.binding, f.params);
  expect(begin).not.toHaveBeenCalled();
  expect(f.authorize).toHaveBeenCalledTimes(6);
});
