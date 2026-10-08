import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { createFileLockManager } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { realpathSync } from "../src/realpath.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { readSidecarLockSnapshot } from "./helpers/sidecar-snapshot.js";
import { useTempDirs } from "./helpers/vitest.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { loadTestNative, loadWindowsSimulationNative } from "./helpers/native-probe.js";

const { tempRoot } = useTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const finalResolverOutcomes = ["outside", "EPERM", "EBADF"] as const;
beforeEach(() => {
  const binding = loadTestNative("required-env", loadWindowsSimulationNative);
  if (binding) __setNativeLoaderForTest(() => binding);
});
afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __resetNativeLoaderForTest();
});

function interceptFinalResolution(
  lockPath: string,
  resolve: (handle: FileHandle) => string,
  active = () => true,
) {
  const realpath = realpathSync.native;
  let armed = false, descriptor: FileHandle | undefined;
  vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
    if (armed && String(args[0]) === lockPath) {
      armed = false;
      return resolve(descriptor!);
    }
    return realpath(...args);
  });
  __setFsSafeTestHooksForTest({
    afterOpen(candidate, handle) {
      if (candidate === lockPath && active()) descriptor = handle;
    },
    beforeRootReadFinalFence(candidate) {
      if (candidate === lockPath && active()) armed = true;
    },
  });
  return { get descriptor() { return descriptor; } };
}

it.each(["EPERM", "EBADF"])("does not brand a final canonical identity %s as a resolver failure", async (code) => {
  const capability = await root(await tempRoot("sidecar-canonical-identity-failure-"));
  const lockPath = path.join(capability.rootReal, "state.lock");
  await capability.create("state.lock", "{}");
  const failure = Object.assign(new Error("canonical identity failure"), { code });
  const realpath = realpathSync.native, lstat = fsSync.lstatSync.bind(fsSync);
  let descriptor: FileHandle | undefined;
  let armed = false, canonical = false;
  vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
    const result = realpath(...args);
    if (armed && String(args[0]) === lockPath) {
      armed = false;
      canonical = true;
      fsSync.unlinkSync(lockPath);
      Object.defineProperty(process, "platform", { value: "win32" });
    }
    return result;
  });
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    if (canonical && String(args[0]) === lockPath) throw failure;
    return lstat(...args);
  });
  __setFsSafeTestHooksForTest({ beforeRootReadFinalFence(candidate, handle) {
    if (candidate !== lockPath) return;
    descriptor = handle;
    armed = true;
  } });
  const parsePayload = vi.fn(JSON.parse);
  await expect(readSidecarLockSnapshot(lockPath, {
    lockRoot: capability, discardObservation: "unlinked", parsePayload,
  })).rejects.toBe(failure);
  expect(parsePayload).not.toHaveBeenCalled();
  expect(descriptor?.fd).toBe(-1);
});

it.each(finalResolverOutcomes)("retries a final %s resolution failure only with inspectable unlink evidence", async (outcome) => {
  const capability = await root(await tempRoot("sidecar-final-containment-"));
  const target = path.join(capability.rootReal, "state"), lockPath = `${target}.lock`;
  const ownerManager = createFileLockManager(`final-containment-owner:${target}`);
  const waiterManager = createFileLockManager(`final-containment-waiter:${target}`);
  const owner = await ownerManager.acquire(target, { lockRoot: capability, payload: () => ({ owner: 1 }) });
  const outsidePath = path.join(path.dirname(capability.rootReal), "delete-pending.lock");
  let injected = false;
  const probe = interceptFinalResolution(lockPath, (descriptor) => {
    injected = true;
    fsSync.unlinkSync(lockPath);
    expect(fsSync.fstatSync(descriptor.fd, { bigint: true }).nlink).toBe(0n);
    if (outcome !== "outside") {
      Object.defineProperty(process, "platform", { value: "win32" });
      throw Object.assign(new Error("final resolver failure"), { code: outcome });
    }
    return outsidePath;
  }, () => !injected);
  const open = capability.open.bind(capability);
  vi.spyOn(capability, "open").mockImplementationOnce(async (...args) => {
    try {
      return await open(...args);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
  const parsePayload = vi.fn(JSON.parse);
  const waiter = await waiterManager.acquire(target, {
    lockRoot: capability, payload: () => ({ owner: 2 }), parsePayload,
    retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
  });
  expect(injected).toBe(true);
  expect(parsePayload).not.toHaveBeenCalled();
  expect(probe.descriptor?.fd).toBe(-1);
  await expect(waiter.verifyStillHeld()).resolves.toBe(true);
  await waiter.release();
  await owner.release();
  expect(waiterManager.heldEntries()).toEqual([]);
  expect(ownerManager.heldEntries()).toEqual([]);
});

it.each(finalResolverOutcomes.flatMap(
  outcome => ["linked", "unknown", "changed"].map(control => ({ control, outcome })),
))(
  "rejects a final $outcome result with $control descriptor evidence",
  async ({ control, outcome }) => {
    const capability = await root(await tempRoot("sidecar-final-containment-control-"));
    const lockPath = path.join(capability.rootReal, "state.lock");
    await capability.create("state.lock", "{}");
    const outsidePath = path.join(path.dirname(capability.rootReal), "outside.lock");
    const probe = interceptFinalResolution(lockPath, (descriptor) => {
      if (control !== "linked") {
        fsSync.unlinkSync(lockPath);
        Object.defineProperty(process, "platform", { value: "win32" });
        const fstat = fsSync.fstatSync.bind(fsSync);
        vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
          const value = fstat(fd, options);
          if (fd === descriptor.fd && options?.bigint) {
            (value as fsSync.BigIntStats).ino = control === "unknown"
              ? 0n
              : BigInt(value.ino) + 1n;
          }
          return value;
        });
      }
      if (outcome !== "outside") {
        Object.defineProperty(process, "platform", { value: "win32" });
        throw Object.assign(new Error("final resolver failure"), { code: outcome });
      }
      return outsidePath;
    });
    const open = capability.open.bind(capability);
    vi.spyOn(capability, "open").mockImplementationOnce(async (...args) => {
      try {
        return await open(...args);
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    });

    await expect(readSidecarLockSnapshot(lockPath, {
      lockRoot: capability, discardObservation: "unlinked",
    })).rejects.toMatchObject({ code: outcome === "outside" ? "outside-workspace" : outcome });
    expect(probe.descriptor?.fd).toBe(-1);
  },
);

it.skipIf(process.platform === "win32")(
  "rejects final containment discard after the observed parent is replaced",
  async () => {
    const capability = await root(await tempRoot("sidecar-final-containment-parent-"));
    const relative = "parent/state.lock", lockPath = path.join(capability.rootReal, relative);
    const parent = path.dirname(lockPath), displaced = `${parent}.old`;
    await capability.create(relative, "{}");
    const outsidePath = path.join(path.dirname(capability.rootReal), "outside.lock");
    const probe = interceptFinalResolution(lockPath, () => {
      fsSync.unlinkSync(lockPath);
      fsSync.renameSync(parent, displaced);
      fsSync.mkdirSync(parent);
      return outsidePath;
    });

    await expect(readSidecarLockSnapshot(lockPath, {
      lockRoot: capability, discardObservation: "unlinked",
    })).rejects.toMatchObject({ code: "outside-workspace" });
    expect(probe.descriptor?.fd).toBe(-1);
  },
);

it.each(finalResolverOutcomes)("ordinary Root.open preserves a final %s rejection after unlink", async (outcome) => {
  const capability = await root(await tempRoot("root-final-containment-strict-"));
  const lockPath = path.join(capability.rootReal, "state.lock");
  await capability.create("state.lock", "{}");
  const outsidePath = path.join(path.dirname(capability.rootReal), "outside.lock");
  const probe = interceptFinalResolution(lockPath, () => {
    fsSync.unlinkSync(lockPath);
    if (outcome !== "outside") {
      Object.defineProperty(process, "platform", { value: "win32" });
      throw Object.assign(new Error("final resolver failure"), { code: outcome });
    }
    return outsidePath;
  });

  try {
    await expect(capability.open("state.lock")).rejects.toMatchObject({
      code: outcome === "outside" ? "outside-workspace" : outcome,
    });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
  expect(probe.descriptor?.fd).toBe(-1);
});

it.each(["numeric", "unknown", "closed", "changed", "linked", "multiple-links"])(
  "rejects Windows resolver failures with %s descriptor evidence", async (control) => {
    const capability = await root(await tempRoot("sidecar-resolver-control-"), { hardlinks: "allow" });
    const lockPath = path.join(capability.rootReal, "state.lock");
    await capability.create("state.lock", "{}");
    const failure = Object.assign(new Error("resolver failed"), { code: "EBADF" });
    let descriptor: FileHandle | undefined;
    __setFsSafeTestHooksForTest({
      async afterOpen(candidate) {
        if (candidate === lockPath && control === "multiple-links") await fs.link(lockPath, `${lockPath}.link`);
      },
      async beforeRootReadFinalFence(candidate, handle) {
        if (candidate !== lockPath) return;
        descriptor = handle;
        __setFsSafeTestHooksForTest();
        if (control === "closed") await handle.close();
        if (["numeric", "unknown", "changed"].includes(control)) {
          const stat = fsSync.fstatSync.bind(fsSync);
          vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
            const value = stat(fd, options);
            if (fd !== handle.fd) return value;
            if (options?.bigint) Object.assign(value, {
              ino: control === "numeric" ? Number(value.ino) : control === "unknown" ? 0n : BigInt(value.ino) + 1n,
            });
            return value;
          });
        }
        Object.defineProperty(process, "platform", { value: "win32" });
        const realpath = realpathSync.native;
        vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
          if (String(args[0]) === lockPath) {
            if (control === "linked") fsSync.renameSync(lockPath, `${lockPath}.moved`);
            else fsSync.unlinkSync(lockPath);
            if (control === "multiple-links") fsSync.unlinkSync(`${lockPath}.link`);
            throw failure;
          }
          return realpath(...args);
        });
      },
    });
    await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardObservation: "unlinked" })).rejects.toBe(failure);
    expect(descriptor?.fd).toBe(-1);
  },
);

it.each(["beforeOpen", "afterOpen", "beforeRootReadFinalFence", "afterRootReadFinalPathIdentityCheck"] as const)(
  "preserves %s hook exceptions even after unlink", async (hook) => {
    for (const failure of [new FsSafeError("not-found", "caller failure"),
      Object.assign(new Error("caller failure"), { code: "ENOENT" }),
      Object.assign(new Error("caller failure"), { code: "EPERM" })]) {
      const capability = await root(await tempRoot("sidecar-hook-error-"));
      const lockPath = path.join(capability.rootReal, "state.lock");
      await capability.create("state.lock", "{}");
      let descriptor: FileHandle | undefined;
      __setFsSafeTestHooksForTest({ [hook]: (candidate: string, handle: FileHandle) => {
        if (candidate !== lockPath) return;
        descriptor = typeof handle === "object" ? handle : undefined;
        __setFsSafeTestHooksForTest();
        fsSync.unlinkSync(lockPath);
        throw failure;
      } });
      await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardObservation: "unlinked" }))
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
    if (candidate !== lockPath) return;
    if (stage === "stat") {
      const fstat = fsSync.fstatSync.bind(fsSync);
      vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
        if (fd === handle.fd) throw failure;
        return fstat(fd, options);
      });
    } else vi.spyOn(handle, "read").mockRejectedValue(failure);
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
    discardObservation: "unlinked", parsePayload: () => { throw failure; },
  })).rejects.toBe(failure);
});

it.each(["EPERM", "EBADF"])("Root.open preserves the Windows resolver %s object and closes its unlinked fd", async (code) => {
  const capability = await root(await tempRoot("root-resolver-strict-"));
  const lockPath = path.join(capability.rootReal, "state.lock");
  await capability.create("state.lock", "{}");
  const failure = Object.assign(new Error("resolver failure"), { code });
  let descriptor: FileHandle | undefined;
  __setFsSafeTestHooksForTest({ beforeRootReadFinalFence(candidate, handle) {
    if (candidate !== lockPath) return;
    descriptor = handle;
    __setFsSafeTestHooksForTest();
    Object.defineProperty(process, "platform", { value: "win32" });
    const realpath = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
      if (String(args[0]) === lockPath) {
        fsSync.unlinkSync(lockPath);
        throw failure;
      }
      return realpath(...args);
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
  __setFsSafeTestHooksForTest({ async beforeRootReadFinalFence(candidate) {
    if (candidate !== lockPath) return;
    __setFsSafeTestHooksForTest();
    await fs.unlink(lockPath);
  } });
  await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, parsePayload }))
    .rejects.toMatchObject({ code: "not-found" });
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
  await expect(readSidecarLockSnapshot(lockPath, { lockRoot: capability, discardObservation: "unlinked" }))
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
    const realpath = realpathSync.native;
    let deny = false, observingFirst = false;
    vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
      if (args[0] === firstPath && deny && observingFirst) {
        deny = false;
        fsSync.unlinkSync(firstPath);
        throw failure;
      }
      return realpath(...args);
    });
    let unblock!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const resume = new Promise<void>((resolve) => { unblock = resolve; });
    const descriptors: FileHandle[] = [];
    __setFsSafeTestHooksForTest({ async beforeRootReadFinalFence(candidate, handle) {
      descriptors.push(handle);
      if (candidate === firstPath && observingFirst) {
        deny = true;
      } else if (candidate === secondPath) {
        if (order === "nested") await expect(observeFirst()).resolves.toBeNull();
        if (order === "interleaved") { entered(); await resume; }
        throw failure;
      }
    } });
    const observeFirst = async () => {
      observingFirst = true;
      try { return await readSidecarLockSnapshot(firstPath, { lockRoot: capability, discardObservation: "unlinked" }); }
      finally { observingFirst = false; }
    };
    if (order === "sequential") {
      await expect(observeFirst()).resolves.toBeNull();
      await capability.create("first.lock", "replacement");
    }
    const second = expect(readSidecarLockSnapshot(secondPath, { lockRoot: capability, discardObservation: "unlinked" }))
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
