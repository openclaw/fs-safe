import fsSync from "node:fs";
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
  describe(`${variant} temp workspace admission observations`, () => {
    async function create(rootDir: string, options: Partial<TempWorkspaceOptions> = {}) {
      const params = { rootDir, prefix: "workspace-", ...options };
      return variant === "async" ? await tempWorkspace(params) : tempWorkspaceSync(params);
    }

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
        let modeDescriptorClosed = false;
        let rootObservationsAfterClose = 0;
        const isChild = (name: unknown): name is string => typeof name === "string" &&
          path.dirname(name) === rootDir && path.basename(name).startsWith("workspace-");
        if (variant === "async") {
          const open = fs.open.bind(fs);
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (isChild(args[0])) {
              const close = handle.close.bind(handle);
              vi.spyOn(handle, "close").mockImplementation(async () => {
                await close();
                modeDescriptorClosed = true;
                events.push("mode-close");
              });
            }
            return handle;
          });
        } else {
          let childFd: number | undefined;
          const open = fsSync.openSync.bind(fsSync);
          const close = fsSync.closeSync.bind(fsSync);
          vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
            const fd = open(...args);
            if (isChild(args[0])) childFd = fd;
            return fd;
          });
          vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
            close(fd);
            if (fd === childFd && !modeDescriptorClosed) {
              modeDescriptorClosed = true;
              events.push("mode-close");
            }
          });
        }
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (modeDescriptorClosed && name === rootDir && options?.bigint === true) {
            rootObservationsAfterClose += 1;
            if (rootObservationsAfterClose === 1) events.push("ancestry");
            if (rootObservationsAfterClose === 2) events.push("cleanup-parent");
          }
          if (modeDescriptorClosed && isChild(name) && options?.bigint === true) {
            events.push("child-security");
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
            "mode-close", "ancestry", "cleanup-parent", "child-security", "register",
          ]);
        } finally {
          await workspace.cleanup();
        }
      },
    );

    it.runIf(process.platform !== "win32").each([
      "grandparent-mode", "child-replacement", "child-mode", "child-owner",
    ] as const)(
      "rejects %s after mode descriptor close and before cleanup adoption", async (change) => {
        const base = await tempRoot("fs-safe-workspace-final-ancestry-");
        const grandparent = path.join(base, "grandparent");
        const rootDir = path.join(grandparent, "parent", "root");
        await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
        let child = "";
        let modeDescriptorClosed = false;
        let finalAncestryObserved = false;
        let childObservationsAfterClose = 0;
        const isChild = (name: unknown): name is string => typeof name === "string" &&
          path.dirname(name) === rootDir && path.basename(name).startsWith("workspace-");
        const afterModeClose = () => {
          modeDescriptorClosed = true;
          if (change === "grandparent-mode") fsSync.chmodSync(grandparent, 0o770);
        };
        if (variant === "async") {
          const open = fs.open.bind(fs);
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (isChild(args[0])) {
              child = args[0];
              const close = handle.close.bind(handle);
              vi.spyOn(handle, "close").mockImplementation(async () => {
                await close();
                afterModeClose();
              });
            }
            return handle;
          });
        } else {
          let childFd: number | undefined;
          const open = fsSync.openSync.bind(fsSync);
          const close = fsSync.closeSync.bind(fsSync);
          vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
            const fd = open(...args);
            if (isChild(args[0])) {
              child = args[0];
              childFd = fd;
            }
            return fd;
          });
          vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
            close(fd);
            if (fd === childFd && !modeDescriptorClosed) afterModeClose();
          });
        }
        const lstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (modeDescriptorClosed && name === grandparent && !finalAncestryObserved) {
            finalAncestryObserved = true;
            if (change === "child-replacement") {
              // Keep the ancestry unchanged while substituting the child
              // during its final pass. The subsequent child check must reject.
              fsSync.renameSync(child, `${child}.original`);
              fsSync.mkdirSync(child, { mode: 0o700 });
              fsSync.writeFileSync(path.join(child, "keep"), "replacement");
            }
          }
          if (modeDescriptorClosed && name === child) {
            childObservationsAfterClose += 1;
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
        expect(modeDescriptorClosed).toBe(true);
        expect(finalAncestryObserved).toBe(true);
        expect(childObservationsAfterClose).toBe(change === "grandparent-mode" ? 0 : 1);
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
  });
}
