import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { tempWorkspace, tempWorkspaceSync, type TempWorkspaceOptions } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import * as descriptors from "../src/temp-workspace-descriptor.js";
import { admitTempWorkspaceRootSync } from "../src/temp-workspace-admission.js";
import { TempWorkspaceCleanupCapability } from "../src/temp-workspace-owner.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

function cleanupBinding(probe: ReturnType<typeof vi.fn>): NativeBinding {
  return {
    closeOwnedFd: vi.fn(),
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

    it.each([
      { rootState: "alias", closeFails: true }, { rootState: "missing", closeFails: true },
      { rootState: "alias", closeFails: false }, { rootState: "missing", closeFails: false },
    ] as const)(
      "preserves eager parent failures: root=$rootState closeFails=$closeFails",
      async ({ rootState, closeFails }) => {
        const base = await tempRoot("fs-safe-workspace-eager-close-");
        const actualRoot = path.join(base, "root");
        const rootDir = rootState === "alias" ? path.join(base, "alias") : actualRoot;
        if (rootState === "alias") {
          await fs.mkdir(actualRoot, { mode: 0o700 });
          await fs.symlink(actualRoot, rootDir, process.platform === "win32" ? "junction" : "dir");
        }
        configureFsSafeNative({ mode: "auto" });
        const probe = vi.fn(() => true);
        const binding = cleanupBinding(probe);
        __setNativeLoaderForTest(() => binding);

        const admissionFailure = Object.assign(new Error("parent admission rejected"), { code: "EIO" });
        const closeFailure = Object.assign(new Error("parent close rejected"), { code: "EIO" });
        const openParent = descriptors.openTempWorkspaceCleanupParent;
        let openingParent = false;
        vi.spyOn(descriptors, "openTempWorkspaceCleanupParent").mockImplementation((...args) => {
          openingParent = true;
          try { return openParent(...args); }
          finally { openingParent = false; }
        });
        const open = fsSync.openSync.bind(fsSync);
        const fstat = fsSync.fstatSync.bind(fsSync);
        const close = fsSync.closeSync.bind(fsSync);
        let parentFd: number | undefined;
        let parentOpens = 0;
        let admissionFailures = 0;
        let parentCloses = 0;
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = open(...args);
          if (openingParent) { parentFd = fd; parentOpens += 1; }
          return fd;
        });
        vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, ...args) => {
          if (openingParent && fd === parentFd && admissionFailures === 0) {
            admissionFailures += 1;
            throw admissionFailure;
          }
          return fstat(fd, ...args);
        });
        const closeSpy = vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
          if (openingParent && fd === parentFd) {
            parentCloses += 1;
            close(fd); // Release the test fd, but model a close that reports failure.
            if (closeFails) throw closeFailure;
            return;
          }
          return close(fd);
        });
        const mkdtemp = vi.spyOn(fs, "mkdtemp");
        const mkdtempSync = vi.spyOn(fsSync, "mkdtempSync");
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        let workspace: Awaited<ReturnType<typeof create>> | undefined;
        let failure: unknown;
        try {
          try { workspace = await create(rootDir); }
          catch (error) { failure = error; }
          if (closeFails) {
            expect(failure).toBeInstanceOf(AggregateError);
            expect((failure as AggregateError).errors).toEqual([admissionFailure, closeFailure]);
          } else {
            expect(failure).toBeUndefined();
            expect(workspace).toBeDefined();
          }
          expect(parentFd).toBeDefined();
          expect(parentOpens).toBe(1);
          expect(admissionFailures).toBe(1);
          expect(parentCloses).toBe(1);
          if (closeFails) {
            expect(closeSpy.mock.calls.filter(([fd]) => fd === parentFd)).toHaveLength(1);
            expect(mkdtemp).not.toHaveBeenCalled();
            expect(mkdtempSync).not.toHaveBeenCalled();
            expect(register).not.toHaveBeenCalled();
          }
          expect(probe).not.toHaveBeenCalled();
          expect(binding.renameNoReplace).not.toHaveBeenCalled();
          expect(binding.removeOwnedTree).not.toHaveBeenCalled();
          expect(binding.removeOwnedTreeSync).not.toHaveBeenCalled();
          if (closeFails) expect(await fs.readdir(actualRoot)).toEqual([]);
          if (rootState === "alias") {
            expect((await fs.lstat(rootDir)).isSymbolicLink()).toBe(true);
            expect(await fs.realpath(rootDir)).toBe(await fs.realpath(actualRoot));
          }
        } finally {
          // Also make a baseline failure clean: the unfixed implementation returns a workspace.
          await workspace?.cleanup();
        }
      },
    );

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
    const assertAncestry = vi.spyOn(admission, "assertAncestry");
    expect(probe).not.toHaveBeenCalled();
    expect(capability.parent).toBeUndefined();
    expect(capability.canRemoveOwnedTree).toBe(false);
    capability.prepareChildCreation();
    capability.prepareChildCreation();
    expect(assertAncestry).toHaveBeenCalledTimes(1);
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

  it("replays admitted ancestry for a retry, seals the winner, and does not reprobe", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-capability-replay-");
    const admission = admitTempWorkspaceRootSync(rootDir);
    configureFsSafeNative({ mode: "auto" });
    const probe = vi.fn(() => true);
    __setNativeLoaderForTest(() => cleanupBinding(probe));
    const prepare = vi.spyOn(admission, "prepareChildCreation");
    const replay = vi.spyOn(admission, "associateAncestry");
    const close = vi.spyOn(fsSync, "closeSync");
    const capability = new TempWorkspaceCleanupCapability(rootDir, "compatible", admission, 0o700);
    const parentFd = capability.parent?.fd;
    expect(parentFd).toBeDefined();
    capability.prepareChildCreation();
    capability.prepareChildCreation();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(capability.canRemoveOwnedTree).toBe(true);
    expect(capability.admitChildDescriptor(true)).toBe(true);
    expect(capability.canRemoveOwnedTree).toBe(true);
    capability.assertCurrent();
    expect(() => capability.prepareChildCreation()).toThrowError(
      expect.objectContaining({ code: "path-mismatch" }),
    );
    capability.close();
    capability.close();
    expect(capability.canRemoveOwnedTree).toBe(false);
    expect(() => capability.prepareChildCreation()).toThrowError(
      expect.objectContaining({ code: "path-mismatch" }),
    );
    expect(probe).toHaveBeenCalledTimes(1);
    expect(close.mock.calls.filter(([fd]) => fd === parentFd)).toHaveLength(1);
  });

  it.each(["initial", "replay"] as const)(
    "makes a failed %s preparation terminal",
    async (failurePoint) => {
      const rootDir = await tempRoot("fs-safe-workspace-capability-terminal-");
      const admission = admitTempWorkspaceRootSync(rootDir);
      configureFsSafeNative({ mode: "auto" });
      const probe = vi.fn(() => true);
      __setNativeLoaderForTest(() => cleanupBinding(probe));
      const capability = new TempWorkspaceCleanupCapability(rootDir, "compatible", admission, 0o700);
      const parentFd = capability.parent?.fd;
      expect(parentFd).toBeDefined();
      if (failurePoint === "replay") capability.prepareChildCreation();
      const failure = new Error(`${failurePoint} preparation rejected`);
      const boundary = failurePoint === "initial"
        ? vi.spyOn(admission, "prepareChildCreation").mockImplementation(() => { throw failure; })
        : vi.spyOn(admission, "associateAncestry").mockImplementation(() => { throw failure; });
      expect(() => capability.prepareChildCreation()).toThrow(failure);
      expect(boundary).toHaveBeenCalledTimes(1);
      expect(capability.canRemoveOwnedTree).toBe(false);
      expect(() => capability.prepareChildCreation()).toThrowError(
        expect.objectContaining({ code: "path-mismatch" }),
      );
      expect(() => capability.admitChildDescriptor(true)).toThrowError(
        expect.objectContaining({ code: "path-mismatch" }),
      );
      expect(boundary).toHaveBeenCalledTimes(1);
      const close = vi.spyOn(fsSync, "closeSync");
      capability.close();
      capability.close();
      expect(close.mock.calls.filter(([fd]) => fd === parentFd)).toHaveLength(1);
      expect(probe).toHaveBeenCalledTimes(1);
    },
  );

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
