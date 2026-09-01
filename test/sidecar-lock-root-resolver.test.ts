import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { readSidecarLockSnapshot } from "../src/sidecar-lock-reclaim.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

it.each(["EPERM", "EBADF"])("retries the recorded Windows resolver %s only with inspectable unlink evidence", async (code) => {
  const capability = await root(await tempRoot("sidecar-windows-resolver-"));
  const target = path.join(capability.rootReal, "state"), lockPath = `${target}.lock`;
  const ownerManager = createFileLockManager(`resolver-owner:${target}`);
  const waiterManager = createFileLockManager(`resolver-waiter:${target}`);
  const owner = await ownerManager.acquire(target, { lockRoot: capability, payload: () => ({ owner: 1 }) });
  const failure = Object.assign(new Error("recorded resolver failure"), {
    code, syscall: code === "EPERM" ? "stat" : "realpath", path: "C:\\$Extend\\$Deleted\\record",
  });
  const open = capability.open.bind(capability);
  let descriptor: FileHandle | undefined;
  const parsePayload = vi.fn(JSON.parse);
  vi.spyOn(capability, "open").mockImplementationOnce(async (...args) => {
    __setFsSafeTestHooksForTest({ async afterOpenedPathIdentityCheck(candidate, handle) {
      if (candidate !== lockPath) return;
      __setFsSafeTestHooksForTest();
      descriptor = handle;
      await owner.release();
      expect((await handle.stat({ bigint: true })).nlink).toBe(0n);
      Object.defineProperty(process, "platform", { value: "win32" });
      const realpath = fs.realpath.bind(fs), stat = fs.stat.bind(fs);
      vi.spyOn(fs, "realpath").mockImplementation(async (...values) => {
        if (String(values[0]) === lockPath) {
          if (code === "EBADF") throw failure;
          return failure.path;
        }
        return await realpath(...values);
      });
      vi.spyOn(fs, "stat").mockImplementation(async (...values) => {
        if (String(values[0]) === failure.path) throw failure;
        return await stat(...values);
      });
    } });
    try { return await open(...args); } finally {
      Object.defineProperty(process, "platform", platform);
      vi.mocked(fs.realpath).mockRestore();
      vi.mocked(fs.stat).mockRestore();
    }
  });
  const waiter = await waiterManager.acquire(target, {
    lockRoot: capability, payload: () => ({ owner: 2 }), parsePayload,
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
  });
  expect(parsePayload).not.toHaveBeenCalled();
  expect(descriptor?.fd).toBe(-1);
  await expect(waiter.verifyStillHeld()).resolves.toBe(true);
  await waiter.release();
  expect(waiterManager.heldEntries()).toEqual([]);
});

it.each(["numeric", "unknown", "closed", "changed", "linked", "multiple-links"])(
  "rejects Windows resolver failures with %s descriptor evidence", async (control) => {
    const capability = await root(await tempRoot("sidecar-resolver-control-"));
    const lockPath = path.join(capability.rootReal, "state.lock");
    await capability.create("state.lock", "{}");
    const failure = Object.assign(new Error("resolver failed"), { code: "EBADF" });
    let descriptor: FileHandle | undefined;
    __setFsSafeTestHooksForTest({
      async afterOpen(candidate) {
        if (candidate === lockPath && control === "multiple-links") await fs.link(lockPath, `${lockPath}.link`);
      },
      async afterOpenedPathIdentityCheck(candidate, handle) {
        if (candidate !== lockPath) return;
        descriptor = handle;
        __setFsSafeTestHooksForTest();
        if (control === "linked") await fs.rename(lockPath, `${lockPath}.moved`);
        else await fs.unlink(lockPath);
        if (control === "multiple-links") await fs.unlink(`${lockPath}.link`);
        if (control === "closed") await handle.close();
        if (["numeric", "unknown", "changed"].includes(control)) {
          const stat = handle.stat.bind(handle);
          vi.spyOn(handle, "stat").mockImplementation(async (options) => {
            const value = await stat(options);
            if (options?.bigint) Object.assign(value, {
              ino: control === "numeric" ? Number(value.ino) : control === "unknown" ? 0n : BigInt(value.ino) + 1n,
            });
            return value;
          });
        }
        Object.defineProperty(process, "platform", { value: "win32" });
        const realpath = fs.realpath.bind(fs);
        vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
          if (String(args[0]) === lockPath) throw failure;
          return await realpath(...args);
        });
      },
    });
    await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardUnlinked: true })).rejects.toBe(failure);
    expect(descriptor?.fd).toBe(-1);
  },
);

it.each(["beforeOpen", "afterOpen", "afterOpenedPathIdentityCheck"] as const)(
  "preserves %s hook exceptions even after unlink", async (hook) => {
    for (const failure of [new FsSafeError("not-found", "caller failure"),
      Object.assign(new Error("caller failure"), { code: "ENOENT" }),
      Object.assign(new Error("caller failure"), { code: "EPERM" })]) {
      const capability = await root(await tempRoot("sidecar-hook-error-"));
      const lockPath = path.join(capability.rootReal, "state.lock");
      await capability.create("state.lock", "{}");
      let descriptor: FileHandle | undefined;
      __setFsSafeTestHooksForTest({ [hook]: async (candidate: string, handle: FileHandle) => {
        if (candidate !== lockPath) return;
        descriptor = typeof handle === "object" ? handle : undefined;
        __setFsSafeTestHooksForTest();
        await fs.unlink(lockPath);
        throw failure;
      } });
      await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardUnlinked: true }))
        .rejects.toBe(failure);
      if (descriptor) expect(descriptor.fd).toBe(-1);
    }
  },
);

it.each(["parser", "read", "stat"])("does not retry a Windows %s exception shaped like an open denial", async (stage) => {
  const capability = await root(await tempRoot("sidecar-read-error-"));
  const lockPath = path.join(capability.rootReal, "state.lock");
  await capability.create("state.lock", "{}");
  const failure = Object.assign(new Error("caller failure"), { code: "EPERM", path: lockPath, syscall: "open" });
  const create = vi.spyOn(capability, "create").mockRejectedValue(new FsSafeError("already-exists", "exists"));
  const parsePayload = vi.fn(() => { throw failure; });
  if (stage !== "parser") __setFsSafeTestHooksForTest({ afterOpen(candidate, handle) {
    if (candidate === lockPath) vi.spyOn(handle, stage).mockRejectedValue(failure);
  } });
  Object.defineProperty(process, "platform", { value: "win32" });
  const manager = createFileLockManager(`read-error:${lockPath}`);
  await expect(manager.acquire(path.join(capability.rootReal, "state"), {
    lockRoot: capability, payload: () => ({}), parsePayload,
    retry: { retries: 20, minTimeout: 0, maxTimeout: 0 },
  })).rejects.toBe(failure);
  expect(create).toHaveBeenCalledTimes(1);
  expect(parsePayload).toHaveBeenCalledTimes(stage === "parser" ? 1 : 0);
});

it.each([false, true])("parser ENOENT remains a caller error (Root: %s)", async (bounded) => {
  const capability = await root(await tempRoot("sidecar-parser-missing-"));
  const lockPath = path.join(capability.rootReal, "state.lock");
  await capability.create("state.lock", "{}");
  const failure = Object.assign(new Error("parser failure"), { code: "ENOENT" });
  await expect(readSidecarLockSnapshot(lockPath, {
    ...(bounded ? { lockRoot: capability } : {}),
    discardUnlinked: true, parsePayload: () => { throw failure; },
  })).rejects.toBe(failure);
});

it.each(["EPERM", "EBADF"])("generic Root.open preserves the Windows resolver %s and closes its unlinked fd", async (code) => {
  const capability = await root(await tempRoot("root-resolver-strict-"));
  const lockPath = path.join(capability.rootReal, "state.lock");
  await capability.create("state.lock", "{}");
  const failure = Object.assign(new Error("resolver failure"), { code });
  let descriptor: FileHandle | undefined;
  __setFsSafeTestHooksForTest({ async afterOpenedPathIdentityCheck(candidate, handle) {
    if (candidate !== lockPath) return;
    descriptor = handle;
    __setFsSafeTestHooksForTest();
    await fs.unlink(lockPath);
    Object.defineProperty(process, "platform", { value: "win32" });
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (String(args[0]) === lockPath) throw failure;
      return await realpath(...args);
    });
  } });
  await expect(capability.open("state.lock")).rejects.toBe(failure);
  expect(descriptor?.fd).toBe(-1);
});

it("ordinary snapshot reads do not discard failed descriptor observations", async () => {
  const capability = await root(await tempRoot("sidecar-held-read-strict-"));
  const lockPath = path.join(capability.rootReal, "state.lock");
  await capability.create("state.lock", "{}");
  const parsePayload = vi.fn(JSON.parse);
  __setFsSafeTestHooksForTest({ async afterOpenedPathIdentityCheck(candidate) {
    if (candidate !== lockPath) return;
    __setFsSafeTestHooksForTest();
    await fs.unlink(lockPath);
  } });
  await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, parsePayload }))
    .rejects.toMatchObject({ code: "path-mismatch" });
  expect(parsePayload).not.toHaveBeenCalled();
});

it("does not replay a never-consumed Root open failure in a later observation", async () => {
  const capability = await root(await tempRoot("sidecar-root-replay-"));
  const lockPath = path.join(capability.rootReal, "state.lock");
  const historical = await capability.open("state.lock").catch((error: unknown) => error);
  expect(historical).toBeInstanceOf(FsSafeError);
  await capability.create("state.lock", "foreign");
  const fail = vi.fn(() => { throw historical; });
  __setFsSafeTestHooksForTest({ beforeOpen: fail });
  await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardUnlinked: true }))
    .rejects.toBe(historical);
  expect(fail).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(lockPath, "utf8")).toBe("foreign");
});

it.each(["sequential", "nested", "interleaved"])(
  "isolates %s Root resolver receipts even when the same Error is thrown again", async (order) => {
    const capability = await root(await tempRoot("sidecar-root-receipts-"));
    const firstPath = path.join(capability.rootReal, "first.lock");
    const secondPath = firstPath;
    await capability.create("first.lock", "first");
    // Synthetic Windows resolver EPERM; unlink and descriptor checks are real.
    Object.defineProperty(process, "platform", { value: "win32" });
    const failure = Object.assign(new Error("synthetic resolver failure"), { code: "EPERM" });
    const realpath = fs.realpath.bind(fs);
    let deny = false, observingFirst = false;
    vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (args[0] === firstPath && deny && observingFirst) throw failure;
      return await realpath(...args);
    });
    let unblock!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { unblock = resolve; });
    const descriptors: FileHandle[] = [];
    __setFsSafeTestHooksForTest({ async afterOpenedPathIdentityCheck(candidate, handle) {
      descriptors.push(handle);
      if (candidate === firstPath && observingFirst) {
        await fs.unlink(firstPath);
        deny = true;
      } else if (candidate === secondPath) {
        if (order === "nested") await expect(observeFirst()).resolves.toBeNull();
        if (order === "interleaved") { entered(); await resume; }
        throw failure;
      }
    } });
    const observeFirst = async () => {
      observingFirst = true;
      try { return await readSidecarLockSnapshot(firstPath, { lockRoot: capability, discardUnlinked: true }); }
      finally { observingFirst = false; }
    };
    if (order === "sequential") {
      await expect(observeFirst()).resolves.toBeNull();
      await capability.create("first.lock", "replacement");
    }
    const second = expect(readSidecarLockSnapshot(secondPath, { lockRoot: capability, discardUnlinked: true }))
      .rejects.toBe(failure);
    if (order === "interleaved") {
      await paused;
      try { await expect(observeFirst()).resolves.toBeNull(); } finally { unblock(); }
    }
    await second;
    expect(descriptors).toHaveLength(2);
    expect(descriptors.every((handle) => handle.fd === -1)).toBe(true);
  },
);
