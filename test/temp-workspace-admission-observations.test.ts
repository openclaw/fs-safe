import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { realpathSync } from "../src/realpath.js";
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
  describe(`${variant} temp workspace admission observations`, () => {
    async function create(rootDir: string, options: Partial<TempWorkspaceOptions> = {}) {
      const params = { rootDir, prefix: "workspace-", ...options };
      return variant === "async" ? await tempWorkspace(params) : tempWorkspaceSync(params);
    }

    it("canonicalizes only the complete root during each admission pass", async () => {
      const base = await tempRoot("fs-safe-workspace-canonical-passes-");
      const rootDir = path.join(base, "one", "two", "three");
      await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
      const canonicalize = vi.spyOn(realpathSync, "native");
      const workspace = await create(rootDir);
      try {
        // Initial alias resolution, cleanup-parent retention, pre-mutation,
        // post-mutation parent association, and final ancestry validation.
        expect(canonicalize).toHaveBeenCalledTimes(5);
      } finally {
        canonicalize.mockRestore();
        await workspace.cleanup();
      }
    });

    it("omits the existing-root replay while keeping missing-component observations linear", async () => {
      const samples = new Map<number, { ancestorObservations: number; total: number }>();
      for (const missing of [0, 1, 3, 6]) {
        const base = await tempRoot("fs-safe-workspace-observations-");
        const existing = path.join(base, "existing");
        await fs.mkdir(existing, { mode: 0o700 });
        const rootDir = path.join(existing, ...Array.from({ length: missing }, (_, index) => `part-${index}`));
        let ancestorObservations = 0;
        let total = 0;
        const lstat = fsSync.lstatSync.bind(fsSync);
        const observation = vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          if (options?.bigint === true) {
            total += 1;
            // base is never an immediate mkdir/mkdtemp/chmod parent here.
            if (name === base) ancestorObservations += 1;
          }
          return lstat(name, options);
        });
        const workspace = await create(rootDir);
        samples.set(missing, { ancestorObservations, total });
        observation.mockRestore();
        try {
          // A complete existing root has one snapshot plus the pre-mkdtemp and
          // final-adoption passes. Missing creation retains the extra replay
          // before the first mkdir mutation.
          expect(ancestorObservations).toBe(missing === 0 ? 3 : 4);
        } finally {
          await workspace.cleanup();
        }
      }
      const one = samples.get(1)!.total;
      const three = samples.get(3)!.total;
      const six = samples.get(6)!.total;
      expect((three - one) / 2).toBe(5);
      expect((six - three) / 3).toBe(5);
    });

    it.runIf(process.platform !== "win32")(
      "orders final ancestry, cleanup authority, child security, and registration", async () => {
        const base = await tempRoot("fs-safe-workspace-final-order-");
        const grandparent = path.join(base, "grandparent");
        const rootDir = path.join(grandparent, "parent", "root");
        await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
        const events: string[] = [];
        let modeChangeSettled = false;
        let rootObservationsAfterMode = 0;
        let cleanupParentFd: number | undefined;
        let cleanupParentObserved = false;
        let childFd: number | undefined;
        const isChild = (name: unknown): name is string => typeof name === "string" &&
          path.dirname(name) === rootDir && path.basename(name).startsWith("workspace-");
        const openSync = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = openSync(...args);
          if (args[0] === rootDir) cleanupParentFd = fd;
          if (isChild(args[0])) childFd = fd;
          return fd;
        });
        if (variant === "async") {
          const fchmod = fsSync.fchmod.bind(fsSync);
          vi.spyOn(fsSync, "fchmod").mockImplementation((fd, mode, callback) => {
            return fchmod(fd, mode, (error) => {
              if (fd === childFd && !error) {
                modeChangeSettled = true;
                events.push("mode-settled");
              }
              callback(error);
            });
          });
        } else {
          const fchmod = fsSync.fchmodSync.bind(fsSync);
          vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
            fchmod(fd, mode);
            if (fd === childFd) {
              modeChangeSettled = true;
              events.push("mode-settled");
            }
          });
        }
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (modeChangeSettled && name === rootDir && options?.bigint === true) {
            rootObservationsAfterMode += 1;
            if (rootObservationsAfterMode === 1) events.push("ancestry");
          }
          if (modeChangeSettled && isChild(name) && options?.bigint === true) {
            events.push("child-security");
          }
          return stat;
        });
        const fstat = fsSync.fstatSync.bind(fsSync);
        vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
          const stat = fstat(fd, options);
          if (
            modeChangeSettled && rootObservationsAfterMode > 0 &&
            fd === cleanupParentFd && !cleanupParentObserved
          ) {
            cleanupParentObserved = true;
            events.push("cleanup-parent");
          }
          return stat;
        });
        const register = cleanup.registerTempPathForExit.bind(cleanup);
        vi.spyOn(cleanup, "registerTempPathForExit").mockImplementation((...args) => {
          events.push("register");
          return register(...args);
        });
        const workspace = await create(rootDir, { dirMode: 0o750 });
        try {
          expect(events).toEqual([
            "mode-settled", "ancestry", "cleanup-parent", "child-security", "register",
          ]);
        } finally {
          await workspace.cleanup();
        }
      },
    );

    it.runIf(process.platform !== "win32").each([
      "grandparent-mode", "child-replacement", "child-mode", "child-owner",
    ] as const)(
      "rejects %s after mode correction and before cleanup adoption", async (change) => {
        const base = await tempRoot("fs-safe-workspace-final-ancestry-");
        const grandparent = path.join(base, "grandparent");
        const rootDir = path.join(grandparent, "parent", "root");
        await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
        let child = "";
        let modeChangeSettled = false;
        let finalAncestryObserved = false;
        let childObservationsAfterMode = 0;
        const isChild = (name: unknown): name is string => typeof name === "string" &&
          path.dirname(name) === rootDir && path.basename(name).startsWith("workspace-");
        const afterModeChange = () => {
          modeChangeSettled = true;
          if (change === "grandparent-mode") fsSync.chmodSync(grandparent, 0o770);
        };
        let childFd: number | undefined;
        const open = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = open(...args);
          if (isChild(args[0])) {
            child = args[0];
            childFd = fd;
          }
          return fd;
        });
        if (variant === "async") {
          const fchmod = fsSync.fchmod.bind(fsSync);
          vi.spyOn(fsSync, "fchmod").mockImplementation((fd, mode, callback) => {
            return fchmod(fd, mode, (error) => {
              if (fd === childFd && !error) afterModeChange();
              callback(error);
            });
          });
        } else {
          const fchmod = fsSync.fchmodSync.bind(fsSync);
          vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
            fchmod(fd, mode);
            if (fd === childFd) afterModeChange();
          });
        }
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (modeChangeSettled && name === grandparent && !finalAncestryObserved) {
            finalAncestryObserved = true;
            if (change === "child-replacement") {
              // Keep the ancestry unchanged while substituting the child
              // during its final pass. The subsequent child check must reject.
              fsSync.renameSync(child, `${child}.original`);
              fsSync.mkdirSync(child, { mode: 0o700 });
              fsSync.writeFileSync(path.join(child, "keep"), "replacement");
            }
          }
          if (modeChangeSettled && name === child) {
            childObservationsAfterMode += 1;
            if (finalAncestryObserved && typeof stat?.mode === "bigint") {
              if (change === "child-mode") stat.mode = (stat.mode & ~0o7777n) | 0o700n;
              if (change === "child-owner") stat.uid = BigInt(process.geteuid!()) + 1n;
            }
          }
          return stat;
        });
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        await expect(create(rootDir, { dirMode: 0o750 })).rejects.toMatchObject({
          code: change === "grandparent-mode" ? "insecure-permissions" :
            change === "child-owner" ? "not-owned" : "path-mismatch",
        });
        expect(modeChangeSettled).toBe(true);
        expect(finalAncestryObserved).toBe(true);
        expect(childObservationsAfterMode).toBe(change === "grandparent-mode" ? 0 : 1);
        expect(register).not.toHaveBeenCalled();
        cleanup.__cleanupRegisteredTempPathsForTest();
        expect(fsSync.statSync(child).isDirectory()).toBe(true);
        if (change === "grandparent-mode") {
          expect(fsSync.statSync(grandparent).mode & 0o777).toBe(0o770);
        } else if (change === "child-replacement") {
          expect(await fs.readFile(path.join(child, "keep"), "utf8")).toBe("replacement");
          expect(fsSync.statSync(`${child}.original`).isDirectory()).toBe(true);
        }
      },
    );

    it.runIf(process.platform !== "win32").each(["mode", "owner"] as const)(
      "rejects an untrusted final child descriptor %s observation before registration", async (change) => {
        const base = await tempRoot("fs-safe-workspace-final-descriptor-");
        const grandparent = path.join(base, "grandparent");
        const rootDir = path.join(grandparent, "parent", "root");
        await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
        let childFd: number | undefined;
        let finalAncestryStarted = false;
        const isChild = (name: unknown): name is string => typeof name === "string" &&
          path.dirname(name) === rootDir && path.basename(name).startsWith("workspace-");
        const open = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = open(...args);
          if (isChild(args[0])) childFd = fd;
          return fd;
        });
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (name === grandparent && childFd !== undefined) finalAncestryStarted = true;
          return stat;
        });
        const fstat = fsSync.fstatSync.bind(fsSync);
        vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
          const stat = fstat(fd, options);
          if (fd === childFd && finalAncestryStarted && typeof stat.mode === "bigint") {
            if (change === "mode") stat.mode |= 0o022n;
            else stat.uid = BigInt(process.geteuid!()) + 1n;
          }
          return stat;
        });
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        await expect(create(rootDir)).rejects.toMatchObject({
          code: change === "mode" ? "insecure-permissions" : "not-owned",
        });
        expect(childFd).toBeDefined();
        expect(finalAncestryStarted).toBe(true);
        expect(register).not.toHaveBeenCalled();
        expect(() => fsSync.fstatSync(childFd!)).toThrowError(
          expect.objectContaining({ code: "EBADF" }),
        );
      },
    );
  });
}
