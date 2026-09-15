import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { tempWorkspace, tempWorkspaceSync, withTempWorkspace, withTempWorkspaceSync } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import { TempWorkspaceRetainedChild } from "../src/temp-workspace-descriptor.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // Native CI builds the binding; fallback behavior remains testable without it.
}
const { tempRoot } = useRealTempDirs();

function unavailableCleanupBinding(result: "missing" | "false" | "throws") {
  return {
    renameNoReplace: vi.fn(),
    removeOwnedTree: vi.fn(),
    removeOwnedTreeSync: vi.fn(),
    ownedTreeRemovalAvailable: result === "missing" ? undefined : vi.fn((fd: number) => {
      expect(fsSync.fstatSync(fd).isDirectory()).toBe(true);
      if (result === "throws") throw Object.assign(new Error("probe denied"), { code: "EPERM" });
      return false;
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup.__cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

for (const variant of ["async", "sync", "with-async", "with-sync"] as const) {
  describe(`${variant} workspace cleanup capability`, () => {
    async function create(
      rootDir: string,
      run: (dir: string) => void,
      cleanupSafety: "compatible" | "require-bounded" = "compatible",
      dirMode = 0o700,
    ) {
      const options = { rootDir, prefix: "workspace-", cleanupSafety, dirMode };
      if (variant === "async" || variant === "sync") {
        const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
        run(workspace.dir);
        return workspace;
      }
      if (variant === "with-async") {
        return await withTempWorkspace(options, async (workspace) => {
          run(workspace.dir);
          await fs.writeFile(path.join(workspace.dir, "owned.txt"), "owned");
          return "done";
        });
      }
      return withTempWorkspaceSync(options, (workspace) => {
        run(workspace.dir);
        fsSync.writeFileSync(path.join(workspace.dir, "owned.txt"), "owned");
        return "done";
      });
    }

    it.each(["off", "absent-auto", "missing-auto", "absent-require", "missing-require"])(
      "keeps creation and compatible cleanup available in %s",
      async (availability) => {
        const rootDir = await tempRoot("fs-safe-workspace-fallback-");
        configureFsSafeNative({
          mode: availability === "off" ? "off" : availability.endsWith("require") ? "require" : "auto",
        });
        const loader = vi.fn(() => {
          if (availability.startsWith("missing")) return {} as NativeBinding;
          throw new Error("injected unavailable binding");
        });
        __setNativeLoaderForTest(loader);
        let callbackDir = "";
        const created = await create(rootDir, (dir) => { callbackDir = dir; });
        const workspace = typeof created === "object" ? created : undefined;
        const dir = workspace?.dir ?? callbackDir;
        expect(dir).not.toBe("");
        if (workspace) {
          await fs.writeFile(path.join(workspace.dir, "owned.txt"), "owned");
          expect(await workspace.cleanup()).toBe("removed");
          expect(await workspace.cleanup()).toBe("missing");
        } else {
          expect(created).toBe("done");
        }
        await expect(fs.lstat(dir)).rejects.toMatchObject({ code: "ENOENT" });
        expect(loader).toHaveBeenCalledTimes(availability === "off" ? 0 : 1);
      },
    );

    for (const mode of ["auto", "require"] as const) {
      it.each(["missing", "false", "throws"] as const)(
        `uses compatible JavaScript cleanup in ${mode} mode when the probe is %s`,
        async (result) => {
          const rootDir = await tempRoot("fs-safe-workspace-probe-fallback-");
          configureFsSafeNative({ mode });
          const binding = unavailableCleanupBinding(result);
          __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
          const created = await create(rootDir, (dir) => {
            fsSync.mkdirSync(path.join(dir, "nested"));
            fsSync.writeFileSync(path.join(dir, "nested", "owned.txt"), "owned");
            // A later probe result must not upgrade this workspace's authority.
            binding.ownedTreeRemovalAvailable?.mockReturnValue(true);
          });
          if (typeof created === "object") {
            expect(await created.cleanup()).toBe("removed");
            expect(await created.cleanup()).toBe("missing");
          } else {
            expect(created).toBe("done");
          }
          if (binding.ownedTreeRemovalAvailable) {
            expect(binding.ownedTreeRemovalAvailable).toHaveBeenCalledTimes(1);
          }
          expect(binding.renameNoReplace).not.toHaveBeenCalled();
          expect(binding.removeOwnedTree).not.toHaveBeenCalled();
          expect(binding.removeOwnedTreeSync).not.toHaveBeenCalled();
          expect(await fs.readdir(rootDir)).toEqual([]);
        },
      );

      it.each(["missing", "false", "throws"] as const)(
        `rejects require-bounded before child creation in ${mode} mode when the probe is %s`,
        async (result) => {
          const rootDir = await tempRoot("fs-safe-workspace-probe-required-");
          configureFsSafeNative({ mode });
          const binding = unavailableCleanupBinding(result);
          __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
          const open = vi.spyOn(fsSync, "openSync");
          const close = vi.spyOn(fsSync, "closeSync");
          const mkdtemp = vi.spyOn(fs, "mkdtemp");
          const mkdtempSync = vi.spyOn(fsSync, "mkdtempSync");
          const run = vi.fn();
          await expect(create(rootDir, run, "require-bounded")).rejects.toMatchObject({
            name: "FsSafeError", code: "helper-unavailable",
          });
          expect(run).not.toHaveBeenCalled();
          expect(mkdtemp).not.toHaveBeenCalled();
          expect(mkdtempSync).not.toHaveBeenCalled();
          const parentOpen = open.mock.calls.findIndex(([name]) => name === rootDir);
          expect(parentOpen).toBeGreaterThanOrEqual(0);
          const parentFd = open.mock.results[parentOpen]!.value as number;
          expect(close).toHaveBeenCalledWith(parentFd);
          expect(() => fsSync.fstatSync(parentFd)).toThrow();
          if (binding.ownedTreeRemovalAvailable) {
            expect(binding.ownedTreeRemovalAvailable).toHaveBeenCalledExactlyOnceWith(parentFd);
          }
          expect(binding.renameNoReplace).not.toHaveBeenCalled();
          expect(binding.removeOwnedTree).not.toHaveBeenCalled();
          expect(binding.removeOwnedTreeSync).not.toHaveBeenCalled();
          expect(await fs.readdir(rootDir)).toEqual([]);
        },
      );
    }

    it("rejects invalid cleanup safety before filesystem mutation", async () => {
      const base = await tempRoot("fs-safe-workspace-invalid-safety-");
      const rootDir = path.join(base, "root");
      const options = {
        rootDir,
        prefix: "workspace-",
        dirMode: 0,
        cleanupSafety: "unexpected" as never,
      };
      const operation = async () => {
        if (variant === "async") return await tempWorkspace(options);
        if (variant === "sync") return tempWorkspaceSync(options);
        if (variant === "with-async") return await withTempWorkspace(options, async () => undefined);
        return withTempWorkspaceSync(options, () => undefined);
      };
      await expect(operation()).rejects.toThrow("cleanupSafety must be compatible or require-bounded");
      await expect(fs.lstat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.runIf(process.platform !== "win32").each([0, 0o100, 0o200, 0o400, 0o600, 0o050])(
      "rejects require-bounded dirMode %o before creating or registering a child", async (dirMode) => {
        const rootDir = await tempRoot("fs-safe-workspace-mode-required-");
        configureFsSafeNative({ mode: "auto" });
        const loader = vi.fn(() => ({
          renameNoReplace: vi.fn(),
          removeOwnedTree: vi.fn(),
          removeOwnedTreeSync: vi.fn(),
          ownedTreeRemovalAvailable: vi.fn(() => true),
        }) as unknown as NativeBinding);
        __setNativeLoaderForTest(loader);
        const mkdtemp = vi.spyOn(fs, "mkdtemp");
        const mkdtempSync = vi.spyOn(fsSync, "mkdtempSync");
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        const run = vi.fn();
        await expect(create(rootDir, run, "require-bounded", dirMode)).rejects.toMatchObject({
          name: "FsSafeError",
          code: "helper-unavailable",
          message: "temp workspace owned-tree cleanup requires owner read and search in dirMode",
        });
        expect(mkdtemp).not.toHaveBeenCalled();
        expect(mkdtempSync).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(loader).not.toHaveBeenCalled();
        expect(await fs.readdir(rootDir)).toEqual([]);
      },
    );

    it.runIf(process.platform !== "win32")(
      "preserves root admission error precedence over the bounded mode gate", async () => {
        const rootDir = await tempRoot("fs-safe-workspace-mode-root-precedence-");
        await fs.chmod(rootDir, 0o770);
        await expect(create(rootDir, vi.fn(), "require-bounded", 0)).rejects.toMatchObject({
          code: "insecure-permissions",
        });
        expect(await fs.readdir(rootDir)).toEqual([]);
      },
    );

    it("rejects require-bounded cleanup in native-off mode before creating a child", async () => {
      const rootDir = await tempRoot("fs-safe-workspace-owned-required-");
      configureFsSafeNative({ mode: "off" });
      const options = { rootDir, prefix: "workspace-", cleanupSafety: "require-bounded" as const };
      const run = vi.fn();
      const operation = async () => {
        if (variant === "async") return await tempWorkspace(options);
        if (variant === "sync") return tempWorkspaceSync(options);
        if (variant === "with-async") return await withTempWorkspace(options, async () => run());
        return withTempWorkspaceSync(options, () => run());
      };
      await expect(operation()).rejects.toMatchObject({
        name: "FsSafeError",
        code: "helper-unavailable",
      });
      expect(run).not.toHaveBeenCalled();
      expect(await fs.readdir(rootDir)).toEqual([]);
    });

    it("rejects require-bounded cleanup when the parent descriptor is unavailable", async () => {
      const rootDir = await tempRoot("fs-safe-workspace-parent-unavailable-");
      configureFsSafeNative({ mode: "auto" });
      __setNativeLoaderForTest(() => ({
        renameNoReplace: vi.fn(),
        removeOwnedTree: vi.fn(),
        removeOwnedTreeSync: vi.fn(),
        ownedTreeRemovalAvailable: vi.fn(() => true),
      }) as unknown as NativeBinding);
      const open = fsSync.openSync;
      vi.spyOn(fsSync, "openSync").mockImplementation((name, ...args) => {
        if (name === rootDir) throw Object.assign(new Error("descriptor unavailable"), { code: "EISDIR" });
        return open(name, ...args);
      });
      const options = { rootDir, prefix: "workspace-", cleanupSafety: "require-bounded" as const };
      const operation = async () => {
        if (variant === "async") return await tempWorkspace(options);
        if (variant === "sync") return tempWorkspaceSync(options);
        if (variant === "with-async") return await withTempWorkspace(options, async () => undefined);
        return withTempWorkspaceSync(options, () => undefined);
      };
      await expect(operation()).rejects.toMatchObject({
        name: "FsSafeError",
        code: "helper-unavailable",
      });
      expect(await fs.readdir(rootDir)).toEqual([]);
    });
  });
}

for (const variant of ["async", "sync"] as const) {
  describe(`${variant} workspace final-mode cleanup authority`, () => {
    function availableCleanupBinding() {
      return {
        renameNoReplace: vi.fn(),
        removeOwnedTree: vi.fn(),
        removeOwnedTreeSync: vi.fn(),
        ownedTreeRemovalAvailable: vi.fn(() => true),
      };
    }

    it.runIf(process.platform !== "win32").each([0, 0o100, 0o400, 0o600])(
      "keeps compatible dirMode %o on fallback after caller permission repair", async (dirMode) => {
        const rootDir = await tempRoot("fs-safe-workspace-mode-compatible-");
        configureFsSafeNative({ mode: "require" });
        const binding = availableCleanupBinding();
        __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
        const transfer = vi.spyOn(TempWorkspaceRetainedChild.prototype, "transfer");
        const options = { rootDir, prefix: "workspace-", dirMode };
        const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
        try {
          expect(fsSync.lstatSync(workspace.dir).mode & 0o7777).toBe(dirMode);
          expect(transfer).toHaveBeenCalledExactlyOnceWith(false);
          expect(binding.ownedTreeRemovalAvailable).not.toHaveBeenCalled();
        } finally {
          // Caller-directed repair keeps fixture cleanup usable without assuming
          // pathname recursive removal can traverse a restricted directory.
          await fs.chmod(workspace.dir, 0o700);
        }
        await fs.writeFile(path.join(workspace.dir, "owned.txt"), "owned");
        const rm = vi.spyOn(fs, "rm");
        const rmSync = vi.spyOn(fsSync, "rmSync");
        expect(await workspace.cleanup()).toBe("removed");
        expect(rm).toHaveBeenCalledTimes(variant === "async" ? 1 : 0);
        expect(rmSync).toHaveBeenCalledTimes(variant === "sync" ? 1 : 0);
        expect(binding.renameNoReplace).not.toHaveBeenCalled();
        expect(binding.removeOwnedTree).not.toHaveBeenCalled();
        expect(binding.removeOwnedTreeSync).not.toHaveBeenCalled();
        expect(await fs.readdir(rootDir)).toEqual([]);
      },
    );

    it.each(process.platform === "win32" ? [0] : [0o500, 0o700])(
      "admits bounded dirMode %o according to the platform cleanup contract", async (dirMode) => {
        const rootDir = await tempRoot("fs-safe-workspace-mode-eligible-");
        configureFsSafeNative({ mode: "require" });
        const binding = availableCleanupBinding();
        __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
        const transfer = vi.spyOn(TempWorkspaceRetainedChild.prototype, "transfer");
        const options = { rootDir, prefix: "workspace-", dirMode, cleanupSafety: "require-bounded" as const };
        const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
        try {
          expect(binding.ownedTreeRemovalAvailable).toHaveBeenCalledTimes(1);
          expect(transfer).toHaveBeenCalledExactlyOnceWith(true);
        } finally {
          // The mock rename performs no mutation, so cleanup closes authority
          // after detecting the absent quarantine and the fixture removes it.
          expect(await workspace.cleanup()).toBe("indeterminate");
        }
        expect(binding.renameNoReplace).toHaveBeenCalledTimes(1);
      },
    );
  });
}

describe.runIf(native && typeof native.removeOwnedTree === "function")("retained native cleanup capability", () => {
  it("probes directories without mutation and rejects invalid or file descriptors", async () => {
    const rootDir = await tempRoot("fs-safe-workspace-real-probe-");
    const file = path.join(rootDir, "file");
    await fs.writeFile(file, "keep");
    const parentFd = fsSync.openSync(rootDir, fsSync.constants.O_RDONLY);
    const fileFd = fsSync.openSync(file, fsSync.constants.O_RDONLY);
    try {
      expect(native!.ownedTreeRemovalAvailable!(-1)).toBe(false);
      expect(native!.ownedTreeRemovalAvailable!(fileFd)).toBe(false);
      expect(native!.ownedTreeRemovalAvailable!(parentFd)).toBe(true);
      expect(fsSync.fstatSync(parentFd).isDirectory()).toBe(true);
      expect(await fs.readdir(rootDir)).toEqual(["file"]);
      expect(await fs.readFile(file, "utf8")).toBe("keep");
    } finally {
      fsSync.closeSync(fileFd);
      fsSync.closeSync(parentFd);
    }
  });

  it.each(["async", "sync"] as const)("uses the captured binding after %s creation switches mode off", async (variant) => {
    configureFsSafeNative({ mode: "require" });
    const remove = vi.fn(native!.removeOwnedTree!.bind(native));
    const removeSync = vi.fn(native!.removeOwnedTreeSync!.bind(native));
    const probe = vi.fn(native!.ownedTreeRemovalAvailable!.bind(native));
    __setNativeLoaderForTest(() => ({
      ...native!, removeOwnedTree: remove, removeOwnedTreeSync: removeSync, ownedTreeRemovalAvailable: probe,
    }));
    const rootDir = await tempRoot("fs-safe-workspace-captured-binding-");
    const options = { rootDir, prefix: "workspace-" };
    const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    expect(probe).toHaveBeenCalledTimes(1);
    probe.mockReturnValue(false);
    await workspace.write("owned.txt", "owned");
    configureFsSafeNative({ mode: "off" });
    __resetNativeLoaderForTest();
    const loader = vi.fn(() => { throw new Error("must not reload"); });
    __setNativeLoaderForTest(loader);
    expect(await workspace.cleanup()).toBe("removed");
    expect(await workspace.cleanup()).toBe("missing");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(loader).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(variant === "async" ? 1 : 0);
    expect(removeSync).toHaveBeenCalledTimes(variant === "sync" ? 1 : 0);
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  it.each(["async", "sync"] as const)("closes retained descriptors if %s exit registration fails", async (variant) => {
    configureFsSafeNative({ mode: "require" });
    const rootDir = await tempRoot("fs-safe-workspace-registration-failure-");
    const failure = new Error("injected registration failure");
    vi.spyOn(cleanup, "registerTempPathForExit").mockImplementationOnce(() => { throw failure; });
    const opened = vi.spyOn(fsSync, "openSync");
    await expect(async () => variant === "async"
      ? await tempWorkspace({ rootDir, prefix: "workspace-" })
      : tempWorkspaceSync({ rootDir, prefix: "workspace-" }))
      .rejects.toBe(failure);
    const fds = opened.mock.results
      .filter((result) => result.type === "return")
      .map((result) => result.value as number);
    expect(fds.length).toBeGreaterThanOrEqual(2);
    for (const fd of fds) {
      expect(() => fsSync.fstatSync(fd)).toThrowError(expect.objectContaining({ code: "EBADF" }));
    }
    expect(await fs.readdir(rootDir)).toEqual([]);
  });
});
