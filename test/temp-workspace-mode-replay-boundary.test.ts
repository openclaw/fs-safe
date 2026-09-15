import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
import * as cleanup from "../src/temp-cleanup.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const supportsDirectRequestedMode = process.platform === "linux" || process.platform === "darwin";

function tempWorkspaceSyncWithUmask022(options: Parameters<typeof tempWorkspaceSync>[0]) {
  const previous = process.umask(0o022);
  try {
    return tempWorkspaceSync(options);
  } finally {
    process.umask(previous);
  }
}

beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  cleanup.__cleanupRegisteredTempPathsForTest();
  __resetFsSafeNativeConfigForTest();
});

for (const variant of ["async", "sync"] as const) {
  const supportsReplay = process.platform === "linux" ||
    (process.platform === "darwin" && variant === "sync");
  describe.runIf(supportsReplay)(`${variant} temp workspace mode replay boundary`, () => {
    async function create(rootDir: string) {
      const options = { rootDir, prefix: "workspace-", dirMode: 0o750 };
      if (variant === "async") return await tempWorkspace(options);
      const previous = process.umask(0o077);
      try {
        return tempWorkspaceSync(options);
      } finally {
        process.umask(previous);
      }
    }

    it("rejects a parent replacement after child validation and before chmod", async () => {
      const base = await tempRoot("fs-safe-workspace-mode-parent-replay-");
      const rootDir = path.join(base, "root");
      const originalRoot = path.join(base, "root-original");
      await fs.mkdir(rootDir, { mode: 0o700 });
      let child = "";
      let childObservations = 0;
      const replayObservation = variant === "sync" && supportsDirectRequestedMode ? 1 : 2;
      const lstat = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (typeof name === "string" && path.dirname(name) === rootDir &&
          path.basename(name).startsWith("workspace-")) {
          child = name;
          childObservations += 1;
          if (childObservations === replayObservation) {
            fsSync.renameSync(rootDir, originalRoot);
            fsSync.mkdirSync(rootDir, { mode: 0o700 });
          }
        }
        return stat;
      });
      const fchmod = vi.spyOn(fsSync, variant === "async" ? "fchmod" : "fchmodSync");
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      await expect(create(rootDir)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(childObservations).toBe(replayObservation);
      expect(fchmod).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(fsSync.lstatSync(path.join(originalRoot, path.basename(child))).isDirectory()).toBe(true);
      expect(await fs.readdir(rootDir)).toEqual([]);
    });

    it("never chmods a child-name replacement introduced by the fresh parent check", async () => {
      const rootDir = await tempRoot("fs-safe-workspace-mode-child-replay-");
      let child = "";
      let replacementChild = "";
      let originalChild = "";
      let modeTargetValidated = false;
      let replaced = false;
      let childObservations = 0;
      const validatedObservation = variant === "sync" && supportsDirectRequestedMode ? 1 : 2;
      const lstat = fsSync.lstatSync.bind(fsSync);
      const lstatSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (typeof name === "string" && path.dirname(name) === rootDir &&
          path.basename(name).startsWith("workspace-")) {
          child = name;
          childObservations += 1;
          if (childObservations === validatedObservation) modeTargetValidated = true;
        } else if (name === rootDir && modeTargetValidated && !replaced) {
          replacementChild = child;
          originalChild = `${replacementChild}.original`;
          fsSync.renameSync(replacementChild, originalChild);
          fsSync.mkdirSync(replacementChild, { mode: 0o700 });
          fsSync.writeFileSync(path.join(replacementChild, "keep"), "replacement");
          replaced = true;
        }
        return stat;
      });
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      await expect(create(rootDir)).rejects.toMatchObject({ code: "path-mismatch" });
      lstatSpy.mockRestore();
      expect(replaced).toBe(true);
      expect(register).not.toHaveBeenCalled();
      expect(lstat(replacementChild).mode & 0o7777).toBe(0o700);
      expect(fsSync.lstatSync(originalChild).mode & 0o7777).toBe(0o750);
      expect(await fs.readFile(path.join(replacementChild, "keep"), "utf8")).toBe("replacement");
    });

    it.runIf(variant === "sync" && supportsDirectRequestedMode).each(
      ["unsafe", "mismatch"] as const,
    )(
      "keeps direct requested-mode %s identity replay exact",
      async (kind) => {
        const rootDir = await tempRoot("fs-safe-workspace-direct-identity-");
        const unsafe = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
        let child = "";
        let childFd: number | undefined;
        let exactLstats = 0;
        let numericLstats = 0;
        let exactFstats = 0;
        let numericFstats = 0;
        let initialMode: number | undefined;
        const isChild = (name: unknown): name is string => typeof name === "string" &&
          path.dirname(name) === rootDir && path.basename(name).startsWith("workspace-");
        const mkdir = fsSync.mkdirSync.bind(fsSync);
        vi.spyOn(fsSync, "mkdirSync").mockImplementation((...args) => {
          const result = mkdir(...args);
          if (isChild(args[0])) initialMode = fsSync.statSync(args[0]).mode & 0o7777;
          return result;
        });
        const open = fsSync.openSync.bind(fsSync);
        vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
          const fd = open(...args);
          if (isChild(args[0])) {
            child = args[0];
            childFd = fd;
          }
          return fd;
        });
        const lstat = fsSync.lstatSync.bind(fsSync);
        const lstatSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          const stat = lstat(name, options);
          if (!isChild(name)) return stat;
          if (options?.bigint === true && typeof stat.dev === "bigint") {
            exactLstats += 1;
            stat.dev = unsafe;
            const finalObservation = initialMode === 0o750 ? 1 : 2;
            stat.ino = unsafe +
              (kind === "mismatch" && exactLstats >= finalObservation ? 2n : 1n);
          } else {
            numericLstats += 1;
          }
          return stat;
        });
        const fstat = fsSync.fstatSync.bind(fsSync);
        const fstatSpy = vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
          const stat = fstat(fd, options);
          if (fd !== childFd) return stat;
          if (options?.bigint === true && typeof stat.dev === "bigint") {
            exactFstats += 1;
            stat.dev = unsafe;
            stat.ino = unsafe + 1n;
          } else {
            numericFstats += 1;
          }
          return stat;
        });
        const register = vi.spyOn(cleanup, "registerTempPathForExit");
        let workspace: ReturnType<typeof tempWorkspaceSync> | undefined;
        if (kind === "mismatch") {
          expect(() => tempWorkspaceSync({ rootDir, prefix: "workspace-", dirMode: 0o750 }))
            .toThrowError(expect.objectContaining({ code: "path-mismatch" }));
          expect(register).not.toHaveBeenCalled();
        } else {
          workspace = tempWorkspaceSyncWithUmask022({
            rootDir, prefix: "workspace-", dirMode: 0o750,
          });
          expect(register).toHaveBeenCalledTimes(1);
          expect(workspace.dir).toBe(child);
        }
        expect(initialMode).toBeDefined();
        const modeCorrection = initialMode !== 0o750;
        expect(exactLstats).toBe(modeCorrection ? 2 : 1);
        expect(exactFstats).toBe(2);
        expect(numericLstats).toBe(0);
        expect(numericFstats).toBe(0);
        lstatSpy.mockRestore();
        fstatSpy.mockRestore();
        if (workspace) await workspace.cleanup();
        else expect(() => fsSync.fstatSync(childFd!)).toThrow();
      },
    );
  });
}
