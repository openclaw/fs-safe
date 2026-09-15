import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { tempWorkspace, tempWorkspaceSync, type TempWorkspaceOptions } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import { admitTempWorkspaceRootSync } from "../src/temp-workspace-admission.js";
import { TempWorkspaceCleanupCapability } from "../src/temp-workspace-owner.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

function cleanupBinding(probe: ReturnType<typeof vi.fn>): NativeBinding {
  return {
    renameNoReplace: vi.fn(),
    removeOwnedTree: vi.fn(),
    removeOwnedTreeSync: vi.fn(),
    ownedTreeRemovalAvailable: probe,
  } as unknown as NativeBinding;
}

beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.__cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

for (const variant of ["async", "sync"] as const) {
  describe(`${variant} temp workspace precreation boundary`, () => {
    async function create(rootDir: string) {
      const options = { rootDir, prefix: "workspace-" };
      return variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    }

    it.each(["getter", "trim"] as const)(
      "does not retain a parent descriptor when prefix %s throws",
      async (failurePoint) => {
        const rootDir = await tempRoot("fs-safe-workspace-prefix-failure-");
        const marker = new Error(`prefix ${failurePoint} failed`);
        const retained = new Set<number>();
        let parentOpens = 0;
        const open = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = open(...args);
          if (args[0] === rootDir) {
            parentOpens += 1;
            retained.add(fd);
          }
          return fd;
        });
        const close = fsSync.closeSync.bind(fsSync);
        vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
          retained.delete(fd);
          return close(fd);
        });
        const options = { rootDir } as TempWorkspaceOptions;
        Object.defineProperty(options, "prefix", {
          enumerable: true,
          get: () => {
            if (failurePoint === "getter") throw marker;
            return { trim: () => { throw marker; } } as unknown as string;
          },
        });
        if (variant === "async") {
          await expect(tempWorkspace(options)).rejects.toBe(marker);
        } else {
          expect(() => tempWorkspaceSync(options)).toThrow(marker);
        }
        expect(parentOpens).toBe(0);
        expect(retained).toEqual(new Set());
        expect(await fs.readdir(rootDir)).toEqual([]);
      },
    );

    it("keeps a cleanup-parent descriptor provisional and closes it once on failed pre-admission", async () => {
      const base = await tempRoot("fs-safe-workspace-provisional-parent-");
      const rootDir = path.join(base, "root");
      const original = path.join(base, "root-original");
      await fs.mkdir(rootDir, { mode: 0o700 });
      const open = fsSync.openSync.bind(fsSync);
      let parentFd: number | undefined;
      let replaced = false;
      vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
        if (!replaced && args[0] === rootDir) {
          fsSync.renameSync(rootDir, original);
          fsSync.mkdirSync(rootDir, { mode: 0o700 });
          replaced = true;
        }
        const fd = open(...args);
        if (args[0] === rootDir) parentFd = fd;
        return fd;
      });
      const close = vi.spyOn(fsSync, "closeSync");
      const mkdtemp = vi.spyOn(fs, "mkdtemp");
      const mkdtempSync = vi.spyOn(fsSync, "mkdtempSync");
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      await expect(create(rootDir)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(replaced).toBe(true);
      expect(parentFd).toBeDefined();
      expect(close.mock.calls.filter(([fd]) => fd === parentFd)).toHaveLength(1);
      expect(mkdtemp).not.toHaveBeenCalled();
      expect(mkdtempSync).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
    });

    it.runIf(process.platform !== "win32")(
      "rechecks unsafe ancestry changed by a native probe before mkdtemp",
      async () => {
        const base = await tempRoot("fs-safe-workspace-native-probe-boundary-");
        const ancestor = path.join(base, "ancestor");
        const rootDir = path.join(ancestor, "root");
        await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
        configureFsSafeNative({ mode: "auto" });
        const probe = vi.fn(() => {
          fsSync.chmodSync(ancestor, 0o770);
          return false;
        });
        __setNativeLoaderForTest(() => cleanupBinding(probe));
        const mkdtemp = vi.spyOn(fs, "mkdtemp");
        const mkdtempSync = vi.spyOn(fsSync, "mkdtempSync");
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        await expect(create(rootDir)).rejects.toMatchObject({ code: "insecure-permissions" });
        expect(probe).toHaveBeenCalledTimes(1);
        expect(mkdtemp).not.toHaveBeenCalled();
        expect(mkdtempSync).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
      },
    );

    it("rejects a root replacement made by a native probe before pre-admission", async () => {
      const base = await tempRoot("fs-safe-workspace-native-probe-root-");
      const rootDir = path.join(base, "root");
      const original = path.join(base, "root-original");
      await fs.mkdir(rootDir, { mode: 0o700 });
      configureFsSafeNative({ mode: "auto" });
      const probe = vi.fn(() => {
        fsSync.renameSync(rootDir, original);
        fsSync.mkdirSync(rootDir, { mode: 0o700 });
        return false;
      });
      __setNativeLoaderForTest(() => cleanupBinding(probe));
      const mkdtemp = vi.spyOn(fs, "mkdtemp");
      const mkdtempSync = vi.spyOn(fsSync, "mkdtempSync");
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      await expect(create(rootDir)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(mkdtemp).not.toHaveBeenCalled();
      expect(mkdtempSync).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
    });

    it("dispatches mkdtemp without yielding after complete parent association", async () => {
      const rootDir = await tempRoot("fs-safe-workspace-parent-turn-");
      const open = fsSync.openSync.bind(fsSync);
      let parentFd: number | undefined;
      vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
        const fd = open(...args);
        if (args[0] === rootDir) parentFd = fd;
        return fd;
      });
      let microtaskRan = false;
      let queued = false;
      const fstat = fsSync.fstatSync.bind(fsSync);
      vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
        const stat = fstat(...args);
        if (!queued && args[0] === parentFd) {
          queued = true;
          queueMicrotask(() => { microtaskRan = true; });
        }
        return stat;
      });
      let microtaskAtDispatch: boolean | undefined;
      if (variant === "async") {
        const mkdtemp = fs.mkdtemp.bind(fs);
        vi.spyOn(fs, "mkdtemp").mockImplementation((...args) => {
          microtaskAtDispatch = microtaskRan;
          return mkdtemp(...args);
        });
      } else {
        const mkdtemp = fsSync.mkdtempSync.bind(fsSync);
        vi.spyOn(fsSync, "mkdtempSync").mockImplementation((...args) => {
          microtaskAtDispatch = microtaskRan;
          return mkdtemp(...args);
        });
      }
      const workspace = await create(rootDir);
      expect(queued).toBe(true);
      expect(microtaskAtDispatch).toBe(false);
      expect(microtaskRan).toBe(true);
      await workspace.cleanup();
    });
  });
}

describe("temp workspace provisional cleanup capability", () => {
  function mismatchedParentFstat(parentFd: () => number | undefined) {
    const fstat = fsSync.fstatSync.bind(fsSync);
    return vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
      const stat = fstat(...args);
      if (args[0] === parentFd()) {
        (stat as { ino: number | bigint }).ino = typeof stat.ino === "bigint"
          ? stat.ino + 1n
          : stat.ino + 1;
      }
      return stat;
    });
  }

  it("rejects provisional association before invoking native code", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-probe-rejection-");
    const admission = admitTempWorkspaceRootSync(rootDir);
    configureFsSafeNative({ mode: "auto" });
    const probe = vi.fn(() => true);
    __setNativeLoaderForTest(() => cleanupBinding(probe));
    const open = fsSync.openSync.bind(fsSync);
    let parentFd: number | undefined;
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (args[0] === rootDir) parentFd = fd;
      return fd;
    });
    mismatchedParentFstat(() => parentFd);
    const close = vi.spyOn(fsSync, "closeSync");
    const capability = new TempWorkspaceCleanupCapability(rootDir, "compatible", admission, 0o700);
    expect(probe).not.toHaveBeenCalled();
    expect(capability.parent).toBeUndefined();
    expect(capability.canRemoveOwnedTree).toBe(false);
    capability.prepareChildCreation();
    expect(capability.canRemoveOwnedTree).toBe(false);
    capability.close();
    expect(close.mock.calls.filter(([fd]) => fd === parentFd)).toHaveLength(1);
  });

  it("preserves probe-admission and descriptor-close failures", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-probe-close-failure-");
    const admission = admitTempWorkspaceRootSync(rootDir);
    configureFsSafeNative({ mode: "auto" });
    const probe = vi.fn(() => true);
    __setNativeLoaderForTest(() => cleanupBinding(probe));
    const open = fsSync.openSync.bind(fsSync);
    let parentFd: number | undefined;
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const fd = open(...args);
      if (args[0] === rootDir) parentFd = fd;
      return fd;
    });
    mismatchedParentFstat(() => parentFd);
    const closeFailure = Object.assign(new Error("close rejected"), { code: "EIO" });
    const close = fsSync.closeSync.bind(fsSync);
    let closeAttempts = 0;
    const closeSpy = vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
      if (fd === parentFd) {
        closeAttempts += 1;
        throw closeFailure;
      }
      return close(fd);
    });
    let failure: unknown;
    try {
      new TempWorkspaceCleanupCapability(rootDir, "compatible", admission, 0o700);
    } catch (error) {
      failure = error;
    }
    try {
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        expect.objectContaining({ code: "path-mismatch" }),
        closeFailure,
      ]);
      expect(probe).not.toHaveBeenCalled();
      expect(closeAttempts).toBe(1);
    } finally {
      closeSpy.mockRestore();
      if (parentFd !== undefined) close(parentFd);
    }
  });

  it("withholds native cleanup authority until the complete boundary succeeds", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-capability-gate-");
    const admission = admitTempWorkspaceRootSync(rootDir);
    configureFsSafeNative({ mode: "auto" });
    const probe = vi.fn(() => true);
    __setNativeLoaderForTest(() => cleanupBinding(probe));
    const capability = new TempWorkspaceCleanupCapability(rootDir, "compatible", admission, 0o700);
    try {
      expect(probe).toHaveBeenCalledTimes(1);
      expect(capability.canRemoveOwnedTree).toBe(false);
      capability.prepareChildCreation();
      expect(capability.canRemoveOwnedTree).toBe(true);
    } finally {
      capability.close();
    }
    expect(capability.canRemoveOwnedTree).toBe(false);
  });

  it("keeps native cleanup authority withheld when the complete boundary rejects", async () => {
    const base = await tempRoot("fs-safe-workspace-capability-rejection-");
    const rootDir = path.join(base, "root");
    const original = path.join(base, "root-original");
    await fs.mkdir(rootDir, { mode: 0o700 });
    const admission = admitTempWorkspaceRootSync(rootDir);
    configureFsSafeNative({ mode: "auto" });
    const probe = vi.fn(() => true);
    __setNativeLoaderForTest(() => cleanupBinding(probe));
    const capability = new TempWorkspaceCleanupCapability(rootDir, "compatible", admission, 0o700);
    try {
      expect(capability.canRemoveOwnedTree).toBe(false);
      fsSync.renameSync(rootDir, original);
      fsSync.mkdirSync(rootDir, { mode: 0o700 });
      expect(() => capability.prepareChildCreation()).toThrowError(
        expect.objectContaining({ code: "path-mismatch" }),
      );
      expect(capability.canRemoveOwnedTree).toBe(false);
    } finally {
      capability.close();
    }
  });
});
