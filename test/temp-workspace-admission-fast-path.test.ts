import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { tempWorkspace, tempWorkspaceSync, type TempWorkspaceOptions } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.__cleanupRegisteredTempPathsForTest();
  __resetFsSafeNativeConfigForTest();
});

for (const variant of ["async", "sync"] as const) {
  describe(`${variant} temp workspace fast admission`, () => {
    async function create(rootDir: string, options: Partial<TempWorkspaceOptions> = {}) {
      const params = { rootDir, prefix: "workspace-", ...options };
      return variant === "async" ? await tempWorkspace(params) : tempWorkspaceSync(params);
    }

    function isWorkspaceChild(rootDir: string, name: unknown): name is string {
      return typeof name === "string" && path.dirname(name) === rootDir &&
        path.basename(name).startsWith("workspace-");
    }

    function observeFirstChild(rootDir: string, inspect: (dir: string, stat: BigIntStats) => void) {
      const lstat = fsSync.lstatSync.bind(fsSync);
      let observed = false;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (!observed && isWorkspaceChild(rootDir, name) && typeof stat?.ino === "bigint") {
          observed = true;
          inspect(name, stat as BigIntStats);
        }
        return stat;
      });
    }

    function observeChildModeOperations(rootDir: string) {
      let opens = 0;
      let chmods = 0;
      let fstats = 0;
      let lstats = 0;
      let opensAtFirstChmod: number | undefined;
      const childFds = new Set<number>();
      const openSync = fsSync.openSync.bind(fsSync);
      vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
        const fd = openSync(...args);
        if (isWorkspaceChild(rootDir, args[0])) {
          opens += 1;
          childFds.add(fd);
        }
        return fd;
      });
      const lstat = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (isWorkspaceChild(rootDir, name) && options?.bigint === true) lstats += 1;
        return stat;
      });
      const fstat = fsSync.fstatSync.bind(fsSync);
      vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
        const stat = fstat(fd, options);
        if (childFds.has(fd) && options?.bigint === true) fstats += 1;
        return stat;
      });
      if (variant === "async") {
        const fchmod = fsSync.fchmod.bind(fsSync);
        vi.spyOn(fsSync, "fchmod").mockImplementation((fd, mode, callback) => {
          if (childFds.has(fd)) chmods += 1;
          if (childFds.has(fd)) opensAtFirstChmod ??= opens;
          return fchmod(fd, mode, callback);
        });
      } else {
        const fchmod = fsSync.fchmodSync.bind(fsSync);
        vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
          if (childFds.has(fd)) chmods += 1;
          if (childFds.has(fd)) opensAtFirstChmod ??= opens;
          fchmod(fd, mode);
        });
      }
      return {
        opens: () => opens,
        chmods: () => chmods,
        fstats: () => fstats,
        lstats: () => lstats,
        opensAtFirstChmod: () => opensAtFirstChmod,
      };
    }

    it.runIf(process.platform !== "win32")(
      "retains one exact default 0700 descriptor without chmod", async () => {
        const rootDir = await tempRoot("fs-safe-workspace-mode-fast-");
        const operations = observeChildModeOperations(rootDir);
        const chmod = vi.spyOn(fs, "chmod");
        const chmodSync = vi.spyOn(fsSync, "chmodSync");
        const workspace = await create(rootDir);
        try {
          expect(operations.opens()).toBe(1);
          expect(operations.chmods()).toBe(0);
          expect(operations.fstats()).toBe(2);
          expect(operations.lstats()).toBe(2);
          expect(fsSync.lstatSync(workspace.dir).mode & 0o7777).toBe(0o700);
          expect(chmod).not.toHaveBeenCalled();
          expect(chmodSync).not.toHaveBeenCalled();
        } finally {
          await workspace.cleanup();
        }
      },
    );

    it("does not yield between the exact child snapshot and cleanup registration", async () => {
      const rootDir = await tempRoot("fs-safe-workspace-mode-fast-turn-");
      let microtaskRan = false;
      let microtaskRanAtRegistration: boolean | undefined;
      observeFirstChild(rootDir, () => {
        queueMicrotask(() => { microtaskRan = true; });
      });
      const register = cleanup.registerTempPathForExit.bind(cleanup);
      vi.spyOn(cleanup, "registerTempPathForExit").mockImplementation((...args) => {
        microtaskRanAtRegistration = microtaskRan;
        return register(...args);
      });
      const workspace = await create(rootDir);
      expect(microtaskRanAtRegistration).toBe(false);
      expect(microtaskRan).toBe(true);
      await workspace.cleanup();
    });

    it("rejects a matching-mode replacement without dispatching mode correction", async () => {
      const rootDir = await tempRoot("fs-safe-workspace-mode-fast-swap-");
      let child = "";
      observeFirstChild(rootDir, (dir) => {
        child = dir;
        fsSync.renameSync(dir, `${dir}.original`);
        fsSync.mkdirSync(dir, { mode: 0o700 });
        fsSync.writeFileSync(path.join(dir, "keep"), "replacement");
      });
      const operations = observeChildModeOperations(rootDir);
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      await expect(create(rootDir)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(operations.opens()).toBe(1);
      expect(register).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(child, "keep"), "utf8")).toBe("replacement");
      expect(fsSync.lstatSync(`${child}.original`).isDirectory()).toBe(true);
    });

    it.runIf(process.platform !== "win32").each([
      ["requested 0750", 0o750, undefined, undefined],
      ["requested mode 0", 0, undefined, undefined],
      ["requested sticky bit", 0o1700, undefined, undefined],
      ["restrictive creation umask", 0o700, 0o200, 0o500],
    ] as const)(
      "uses one descriptor correction for %s", async (_label, dirMode, creationUmask, expectedInitialMode) => {
        const rootDir = await tempRoot("fs-safe-workspace-mode-correction-");
        let initialMode: number | undefined;
        if (creationUmask !== undefined) {
          if (variant === "async") {
            const mkdtemp = fs.mkdtemp.bind(fs);
            vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
              const previous = process.umask(creationUmask);
              try {
                const dir = await mkdtemp(...args);
                initialMode = fsSync.statSync(dir).mode & 0o7777;
                return dir;
              } finally {
                process.umask(previous);
              }
            });
          } else {
            const mkdtemp = fsSync.mkdtempSync.bind(fsSync);
            vi.spyOn(fsSync, "mkdtempSync").mockImplementation((...args) => {
              const previous = process.umask(creationUmask);
              try {
                const dir = mkdtemp(...args);
                initialMode = fsSync.statSync(dir).mode & 0o7777;
                return dir;
              } finally {
                process.umask(previous);
              }
            });
          }
        }
        const operations = observeChildModeOperations(rootDir);
        const workspace = await create(rootDir, { dirMode });
        try {
          expect(initialMode).toBe(expectedInitialMode);
          expect(operations.opens()).toBe(1);
          expect(operations.chmods()).toBe(1);
          expect(operations.fstats()).toBe(3);
          expect(operations.lstats()).toBe(3);
          expect(operations.opensAtFirstChmod()).toBe(1);
          expect(fsSync.lstatSync(workspace.dir).mode & 0o7777).toBe(dirMode);
        } finally {
          if (dirMode === 0) await fs.chmod(workspace.dir, 0o700);
          await workspace.cleanup();
        }
      },
    );

    it.runIf(variant === "async" && process.platform !== "win32")(
      "settles borrowed descriptor chmod before transfer and registration", async () => {
        const rootDir = await tempRoot("fs-safe-workspace-mode-lease-");
        const fchmod = fsSync.fchmod.bind(fsSync);
        let release!: () => void;
        const paused = new Promise<void>((resolve) => { release = resolve; });
        let enter!: (fd: number) => void;
        const entered = new Promise<number>((resolve) => { enter = resolve; });
        vi.spyOn(fsSync, "fchmod").mockImplementation((fd, mode, callback) => {
          enter(fd);
          void paused.then(() => fchmod(fd, mode, callback));
        });
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        const creating = create(rootDir, { dirMode: 0o750 });
        const fd = await entered;
        try {
          expect(fsSync.fstatSync(fd).isDirectory()).toBe(true);
          expect(register).not.toHaveBeenCalled();
        } finally {
          release();
        }
        const workspace = await creating;
        expect(register).toHaveBeenCalledTimes(1);
        expect(() => fsSync.fstatSync(fd)).toThrowError(
          expect.objectContaining({ code: "EBADF" }),
        );
        await workspace.cleanup();
      },
    );

    it("re-observes a missing component that appears with EEXIST", async () => {
      const base = await tempRoot("fs-safe-workspace-root-eexist-");
      const raced = path.join(base, "raced");
      const rootDir = path.join(raced, "root");
      let injected = false;
      const eexist = () => Object.assign(new Error("component appeared"), { code: "EEXIST" });
      if (variant === "async") {
        const mkdir = fs.mkdir.bind(fs);
        vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
          if (!injected && args[0] === raced) {
            injected = true;
            await mkdir(...args);
            throw eexist();
          }
          return await mkdir(...args);
        });
      } else {
        const mkdir = fsSync.mkdirSync.bind(fsSync);
        vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
          if (!injected && args[0] === raced) {
            injected = true;
            mkdir(...args);
            throw eexist();
          }
          return mkdir(...args);
        });
      }
      const workspace = await create(rootDir);
      try {
        expect(injected).toBe(true);
        expect(path.dirname(workspace.dir)).toBe(rootDir);
        if (process.platform !== "win32") {
          expect(fsSync.lstatSync(raced).mode & 0o7777).toBe(0o700);
        }
      } finally {
        await workspace.cleanup();
      }
    });

    it.runIf(process.platform !== "win32")(
      "rejects an insecure missing component that appears with EEXIST", async () => {
        const base = await tempRoot("fs-safe-workspace-root-eexist-insecure-");
        const raced = path.join(base, "raced");
        const rootDir = path.join(raced, "root");
        let injected = false;
        const eexist = () => Object.assign(new Error("component appeared"), { code: "EEXIST" });
        if (variant === "async") {
          const mkdir = fs.mkdir.bind(fs);
          vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
            if (!injected && args[0] === raced) {
              injected = true;
              await mkdir(...args);
              await fs.chmod(raced, 0o770);
              throw eexist();
            }
            return await mkdir(...args);
          });
        } else {
          const mkdir = fsSync.mkdirSync.bind(fsSync);
          vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
            if (!injected && args[0] === raced) {
              injected = true;
              mkdir(...args);
              fsSync.chmodSync(raced, 0o770);
              throw eexist();
            }
            return mkdir(...args);
          });
        }
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        await expect(create(rootDir)).rejects.toMatchObject({ code: "insecure-permissions" });
        expect(injected).toBe(true);
        expect(register).not.toHaveBeenCalled();
        await expect(fs.lstat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );

    it("rejects a missing-component parent replacement after mkdir", async () => {
      const base = await tempRoot("fs-safe-workspace-root-mkdir-parent-");
      const parent = path.join(base, "parent");
      const original = path.join(base, "parent-original");
      const rootDir = path.join(parent, "root");
      await fs.mkdir(parent, { mode: 0o700 });
      let replaced = false;
      const replaceParent = () => {
        fsSync.renameSync(parent, original);
        fsSync.mkdirSync(parent, { mode: 0o700 });
        replaced = true;
      };
      if (variant === "async") {
        const mkdir = fs.mkdir.bind(fs);
        vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
          const result = await mkdir(...args);
          if (!replaced && args[0] === rootDir) replaceParent();
          return result;
        });
      } else {
        const mkdir = fsSync.mkdirSync.bind(fsSync);
        vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
          const result = mkdir(...args);
          if (!replaced && args[0] === rootDir) replaceParent();
          return result;
        });
      }
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      await expect(create(rootDir)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(replaced).toBe(true);
      expect(register).not.toHaveBeenCalled();
      expect(fsSync.lstatSync(path.join(original, "root")).isDirectory()).toBe(true);
      expect(await fs.readdir(parent)).toEqual([]);
    });

    it.runIf(process.platform === "win32").each([0, 0o700, 0o750, 0o777])(
      "does not claim or initialize POSIX child mode %o", async (dirMode) => {
        const rootDir = await tempRoot("fs-safe-workspace-windows-mode-");
        const operations = observeChildModeOperations(rootDir);
        const chmod = vi.spyOn(fs, "chmod");
        const chmodSync = vi.spyOn(fsSync, "chmodSync");
        const fchmod = vi.spyOn(fsSync, "fchmodSync");
        const workspace = await create(rootDir, { dirMode });
        expect(operations.opens()).toBe(1);
        expect(operations.chmods()).toBe(0);
        expect(chmod).not.toHaveBeenCalled();
        expect(chmodSync).not.toHaveBeenCalled();
        expect(fchmod).not.toHaveBeenCalled();
        await workspace.cleanup();
      },
    );
  });
}
