import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { tempWorkspace, tempWorkspaceSync, type TempWorkspaceOptions } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import { TempWorkspaceRetainedChild } from "../src/temp-workspace-descriptor.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.__cleanupRegisteredTempPathsForTest();
  __resetNativeLoaderForTest();
  __resetFsSafeNativeConfigForTest();
});

for (const variant of ["async", "sync"] as const) {
  describe(`${variant} temp workspace creation admission`, () => {
    async function create(rootDir: string, options: Partial<TempWorkspaceOptions> = {}) {
      const params = { rootDir, prefix: "workspace-", ...options };
      return variant === "async" ? await tempWorkspace(params) : tempWorkspaceSync(params);
    }

    async function createWithModeCorrection(rootDir: string) {
      if (variant !== "sync" || (process.platform !== "linux" && process.platform !== "darwin")) {
        return await create(rootDir, { dirMode: 0o750 });
      }
      const previous = process.umask(0o077);
      try {
        return tempWorkspaceSync({ rootDir, prefix: "workspace-", dirMode: 0o750 });
      } finally {
        process.umask(previous);
      }
    }

    function observeFirstChild(rootDir: string, inspect: (dir: string, stat: BigIntStats) => void) {
      const lstat = fsSync.lstatSync.bind(fsSync);
      let observed = false;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (!observed && typeof name === "string" && path.dirname(name) === rootDir &&
          path.basename(name).startsWith("workspace-") && typeof stat?.ino === "bigint") {
          observed = true;
          inspect(name, stat as BigIntStats);
        }
        return stat;
      });
    }

    function observeDirectDescriptorChild(
      rootDir: string,
      inspect: (dir: string, stat: BigIntStats) => void,
    ) {
      let child = "";
      let childFd: number | undefined;
      const open = fsSync.openSync.bind(fsSync);
      vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
        const fd = open(...args);
        if (typeof args[0] === "string" && path.dirname(args[0]) === rootDir &&
          path.basename(args[0]).startsWith("workspace-")) {
          child = args[0];
          childFd = fd;
        }
        return fd;
      });
      const fstat = fsSync.fstatSync.bind(fsSync);
      let observed = false;
      vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
        const stat = fstat(fd, options);
        if (!observed && fd === childFd && typeof stat.ino === "bigint") {
          observed = true;
          inspect(child, stat);
        }
        return stat;
      });
    }

    it.runIf(process.platform !== "win32").each([0o755, 0o1777])(
      "preserves an admitted supplied root's mode %o", async (mode) => {
        const rootDir = await tempRoot("fs-safe-workspace-root-mode-");
        await fs.chmod(rootDir, mode);
        const chmod = vi.spyOn(fs, "chmod");
        const chmodSync = vi.spyOn(fsSync, "chmodSync");
        const workspace = await create(rootDir);
        expect(fsSync.statSync(rootDir).mode & 0o7777).toBe(mode);
        expect(fsSync.statSync(workspace.dir).mode & 0o777).toBe(0o700);
        expect(chmod).not.toHaveBeenCalled();
        expect(chmodSync).not.toHaveBeenCalled();
        expect(await workspace.cleanup()).toBe("removed");
      },
    );

    it("creates missing root components and preserves a caller-approved root alias", async () => {
      const base = await tempRoot("fs-safe-workspace-root-create-");
      const rootDir = path.join(base, "one", "two");
      const workspace = await create(rootDir);
      expect(path.dirname(workspace.dir)).toBe(rootDir);
      if (process.platform !== "win32") {
        expect(fsSync.statSync(path.dirname(rootDir)).mode & 0o777).toBe(0o700);
        expect(fsSync.statSync(rootDir).mode & 0o777).toBe(0o700);
      }
      await workspace.cleanup();
      const alias = path.join(base, "alias");
      await fs.symlink(rootDir, alias, process.platform === "win32" ? "junction" : "dir");
      const aliased = await create(alias);
      expect(path.dirname(aliased.dir)).toBe(rootDir);
      await aliased.cleanup();
    });

    it.runIf(process.platform !== "win32").each([
      ["root", 0o770], ["root", 0o777], ["ancestor", 0o770], ["ancestor", 0o777],
    ] as const)(
      "rejects a non-sticky writable %s (mode %o) before creating a child", async (kind, mode) => {
        const base = await tempRoot("fs-safe-workspace-root-insecure-");
        const rootDir = path.join(base, "parent");
        await fs.mkdir(rootDir, { mode: 0o700 });
        const insecure = kind === "root" ? rootDir : base;
        await fs.chmod(insecure, mode);
        const chmod = vi.spyOn(fs, "chmod");
        const chmodSync = vi.spyOn(fsSync, "chmodSync");
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        await expect(create(rootDir)).rejects.toMatchObject({ code: "insecure-permissions" });
        expect(await fs.readdir(rootDir)).toEqual([]);
        expect(fsSync.statSync(insecure).mode & 0o7777).toBe(mode);
        expect(chmod).not.toHaveBeenCalled();
        expect(chmodSync).not.toHaveBeenCalled();
        expect(register).not.toHaveBeenCalled();
      },
    );

    it.runIf(process.platform !== "win32")("rejects a foreign-owned supplied root without trying chmod", async () => {
      const rootDir = await tempRoot("fs-safe-workspace-root-owner-");
      const lstat = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (name === rootDir && typeof stat?.uid === "bigint") {
          stat.uid = BigInt(process.geteuid!()) + 1n;
        }
        return stat;
      });
      const chmod = vi.spyOn(fs, "chmod");
      const chmodSync = vi.spyOn(fsSync, "chmodSync");
      await expect(create(rootDir)).rejects.toMatchObject({ code: "not-owned" });
      expect(await fs.readdir(rootDir)).toEqual([]);
      expect(chmod).not.toHaveBeenCalled();
      expect(chmodSync).not.toHaveBeenCalled();
    });

    it.runIf(process.platform !== "win32")("rejects writable child modes before root creation", async () => {
      const base = await tempRoot("fs-safe-workspace-child-mode-");
      const rootDir = path.join(base, "missing");
      await expect(create(rootDir, { dirMode: 0o770 })).rejects.toMatchObject({ code: "insecure-permissions" });
      await expect(fs.lstat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.runIf(process.platform !== "win32").each(["foreign-owner", "writable"])(
      "does not repair or adopt a child first observed with %s", async (kind) => {
        const rootDir = await tempRoot("fs-safe-workspace-child-untrusted-");
        observeFirstChild(rootDir, (_dir, stat) => {
          if (kind === "foreign-owner") stat.uid = BigInt(process.geteuid!()) + 1n;
          else stat.mode |= 0o022n;
        });
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        const chmod = vi.spyOn(fsSync, "fchmod");
        const chmodSync = vi.spyOn(fsSync, "fchmodSync");
        await expect(create(rootDir)).rejects.toMatchObject({
          code: kind === "foreign-owner" ? "not-owned" : "insecure-permissions",
        });
        expect(register).not.toHaveBeenCalled();
        expect(chmod).not.toHaveBeenCalled();
        expect(chmodSync).not.toHaveBeenCalled();
        expect(await fs.readdir(rootDir)).toHaveLength(1);
      },
    );

    for (const cleanupSafety of ["compatible", "require-bounded"] as const) {
      it.runIf(process.platform !== "win32").each(["directory", "symlink"] as const)(
        `rejects a %s replacement before chmod/adoption (${cleanupSafety})`, async (kind) => {
          if (cleanupSafety === "require-bounded") {
            configureFsSafeNative({ mode: "auto" });
            __setNativeLoaderForTest(() => ({
              closeOwnedFd: vi.fn(),
              renameNoReplace: vi.fn(), removeOwnedTree: vi.fn(), removeOwnedTreeSync: vi.fn(),
              ownedTreeRemovalAvailable: vi.fn(() => true),
            }) as unknown as NativeBinding);
          }
          const base = await tempRoot("fs-safe-workspace-child-snapshot-");
          const rootDir = path.join(base, "root");
          const outside = path.join(base, "outside");
          await fs.mkdir(rootDir, { mode: 0o700 });
          await fs.mkdir(outside, { mode: 0o711 });
          await fs.chmod(outside, 0o711);
          await fs.writeFile(path.join(outside, "keep"), "outside");
          let child = "";
          const observe = variant === "sync" &&
            (process.platform === "linux" || process.platform === "darwin")
            ? observeDirectDescriptorChild
            : observeFirstChild;
          observe(rootDir, (dir) => {
            child = dir;
            fsSync.renameSync(dir, `${dir}.original`);
            if (kind === "symlink") fsSync.symlinkSync(outside, dir, "dir");
            else {
              fsSync.mkdirSync(dir, { mode: 0o755 });
              fsSync.writeFileSync(path.join(dir, "keep"), "replacement");
            }
          });
          const register = vi.spyOn(cleanup, "registerTempPathForExit");
          const chmod = vi.spyOn(fs, "chmod");
          const chmodSync = vi.spyOn(fsSync, "chmodSync");
          const fchmod = vi.spyOn(fsSync, "fchmod");
          const fchmodSync = vi.spyOn(fsSync, "fchmodSync");
          const transfer = vi.spyOn(TempWorkspaceRetainedChild.prototype, "transfer");
          await expect(create(rootDir, { dirMode: 0o750, cleanupSafety })).rejects.toBeInstanceOf(Error);
          expect(child).not.toBe("");
          expect(register).not.toHaveBeenCalled();
          expect(chmod).not.toHaveBeenCalled();
          expect(chmodSync).not.toHaveBeenCalled();
          expect(fchmod).not.toHaveBeenCalled();
          expect(fchmodSync).not.toHaveBeenCalled();
          expect(transfer).not.toHaveBeenCalled();
          cleanup.__cleanupRegisteredTempPathsForTest();
          expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("outside");
          expect(fsSync.statSync(outside).mode & 0o777).toBe(0o711);
          expect(fsSync.lstatSync(child).isSymbolicLink()).toBe(kind === "symlink");
          if (kind === "directory") {
            expect(await fs.readFile(path.join(child, "keep"), "utf8")).toBe("replacement");
          }
        },
      );
    }

    it.runIf(process.platform !== "win32")("checks the parent before inspecting or chmodding a new child", async () => {
      const base = await tempRoot("fs-safe-workspace-parent-snapshot-");
      const rootDir = path.join(base, "root");
      await fs.mkdir(rootDir, { mode: 0o700 });
      const mkdir = fsSync.mkdirSync.bind(fsSync);
      const replaceParent = (dir: string) => {
        fsSync.renameSync(rootDir, path.join(base, "original"));
        mkdir(rootDir, { mode: 0o700 });
        mkdir(dir, { mode: 0o755 });
        fsSync.writeFileSync(path.join(dir, "keep"), "replacement");
        return dir;
      };
      if (variant === "async") {
        const mkdtemp = fs.mkdtemp.bind(fs);
        vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => replaceParent(await mkdtemp(...args) as string));
      } else if (process.platform === "linux" || process.platform === "darwin") {
        vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
          const result = mkdir(...args);
          if (typeof args[0] === "string" && path.dirname(args[0]) === rootDir &&
            path.basename(args[0]).startsWith("workspace-")) replaceParent(args[0]);
          return result;
        });
      } else {
        const mkdtemp = fsSync.mkdtempSync.bind(fsSync);
        vi.spyOn(fsSync, "mkdtempSync").mockImplementation((...args) => replaceParent(mkdtemp(...args) as string));
      }
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      const open = vi.spyOn(fsSync, "openSync");
      const chmod = vi.spyOn(fs, "chmod");
      const chmodSync = vi.spyOn(fsSync, "chmodSync");
      const fchmod = vi.spyOn(fsSync, "fchmod");
      const fchmodSync = vi.spyOn(fsSync, "fchmodSync");
      await expect(create(rootDir, { dirMode: 0o750 })).rejects.toMatchObject({ code: "path-mismatch" });
      expect(register).not.toHaveBeenCalled();
      expect(chmod).not.toHaveBeenCalled();
      expect(chmodSync).not.toHaveBeenCalled();
      expect(fchmod).not.toHaveBeenCalled();
      expect(fchmodSync).not.toHaveBeenCalled();
      expect(open.mock.calls.filter(([name]) => typeof name === "string" &&
        path.dirname(name) === rootDir && path.basename(name).startsWith("workspace-")))
        .toHaveLength(0);
      const [name] = await fs.readdir(rootDir);
      expect(await fs.readFile(path.join(rootDir, name!, "keep"), "utf8")).toBe("replacement");
    });

    it.runIf(process.platform !== "win32").each(["failure", "replacement"])(
      "keeps descriptor chmod %s from adopting a child or changing another directory", async (kind) => {
        const base = await tempRoot("fs-safe-workspace-mode-dispatch-");
        const rootDir = path.join(base, "root");
        const outside = path.join(base, "outside");
        await fs.mkdir(rootDir, { mode: 0o700 });
        await fs.mkdir(outside, { mode: 0o711 });
        await fs.chmod(outside, 0o711);
        await fs.writeFile(path.join(outside, "keep"), "outside");
        let child = "";
        let childFd: number | undefined;
        const open = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = open(...args);
          if (typeof args[0] === "string" && path.dirname(args[0]) === rootDir &&
            path.basename(args[0]).startsWith("workspace-")) {
            child = args[0];
            childFd = fd;
          }
          return fd;
        });
        const failure = Object.assign(new Error("chmod rejected"), { code: "EPERM" });
        const beforeChmod = vi.fn(() => {
          if (kind === "failure") throw failure;
          fsSync.renameSync(child, `${child}.original`);
          fsSync.symlinkSync(outside, child, "dir");
        });
        if (variant === "async") {
          const fchmod = fsSync.fchmod.bind(fsSync);
          vi.spyOn(fsSync, "fchmod").mockImplementation((fd, mode, callback) => {
            if (fd === childFd) beforeChmod();
            return fchmod(fd, mode, callback);
          });
        } else {
          const chmod = fsSync.fchmodSync.bind(fsSync);
          vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
            if (fd === childFd) beforeChmod();
            chmod(fd, mode);
          });
        }
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        const transfer = vi.spyOn(TempWorkspaceRetainedChild.prototype, "transfer");
        const close = vi.spyOn(fsSync, "closeSync");
        const operation = createWithModeCorrection(rootDir);
        if (kind === "failure") await expect(operation).rejects.toBe(failure);
        else await expect(operation).rejects.toMatchObject({ code: "not-file" });
        expect(beforeChmod).toHaveBeenCalledTimes(1);
        expect(register).not.toHaveBeenCalled();
        expect(transfer).not.toHaveBeenCalled();
        expect(child).not.toBe("");
        expect(childFd).toBeDefined();
        expect(close.mock.calls.filter(([fd]) => fd === childFd)).toHaveLength(1);
        expect(() => fsSync.fstatSync(childFd!)).toThrowError(
          expect.objectContaining({ code: "EBADF" }),
        );
        expect(fsSync.statSync(outside).mode & 0o7777).toBe(0o711);
        expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("outside");
        const childStat = fsSync.lstatSync(child);
        expect(childStat.isSymbolicLink()).toBe(kind === "replacement");
        if (kind === "failure") expect(childStat.isDirectory()).toBe(true);
        else {
          expect(fsSync.readlinkSync(child)).toBe(outside);
          const original = fsSync.lstatSync(`${child}.original`);
          expect(original.isDirectory()).toBe(true);
          expect(original.isSymbolicLink()).toBe(false);
          expect(original.mode & 0o7777).toBe(0o750);
        }
      },
    );

    it.runIf(process.platform === "win32")("performs no POSIX chmod and rejects unknown child identities", async () => {
      const rootDir = await tempRoot("fs-safe-workspace-windows-admission-");
      const chmod = vi.spyOn(fs, "chmod");
      const chmodSync = vi.spyOn(fsSync, "chmodSync");
      const fchmod = vi.spyOn(fsSync, "fchmodSync");
      const fchmodAsync = vi.spyOn(fsSync, "fchmod");
      const workspace = await create(rootDir);
      expect(chmod).not.toHaveBeenCalled();
      expect(chmodSync).not.toHaveBeenCalled();
      expect(fchmod).not.toHaveBeenCalled();
      expect(fchmodAsync).not.toHaveBeenCalled();
      await workspace.cleanup();
      const lstat = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (typeof name === "string" && path.dirname(name) === rootDir && typeof stat?.ino === "bigint") stat.ino = 0n;
        return stat;
      });
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      await expect(create(rootDir)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(register).not.toHaveBeenCalled();
    });
  });
}
