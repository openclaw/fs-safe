import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
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
  describe.runIf(process.platform === "linux")(`${variant} temp workspace mode replay boundary`, () => {
    async function create(rootDir: string) {
      const options = { rootDir, prefix: "workspace-", dirMode: 0o750 };
      return variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    }

    it("rejects a parent replacement after child validation and before chmod", async () => {
      const base = await tempRoot("fs-safe-workspace-mode-parent-replay-");
      const rootDir = path.join(base, "root");
      const originalRoot = path.join(base, "root-original");
      await fs.mkdir(rootDir, { mode: 0o700 });
      let child = "";
      let childObservations = 0;
      const lstat = fsSync.lstatSync.bind(fsSync);
      vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (typeof name === "string" && path.dirname(name) === rootDir &&
          path.basename(name).startsWith("workspace-")) {
          child = name;
          childObservations += 1;
          if (childObservations === 2) {
            fsSync.renameSync(rootDir, originalRoot);
            fsSync.mkdirSync(rootDir, { mode: 0o700 });
          }
        }
        return stat;
      });
      const fchmod = vi.spyOn(fsSync, variant === "async" ? "fchmod" : "fchmodSync");
      const register = vi.spyOn(cleanup, "registerTempPathForExit");
      await expect(create(rootDir)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(childObservations).toBe(2);
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
      const lstat = fsSync.lstatSync.bind(fsSync);
      const lstatSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
        const stat = lstat(name, options);
        if (typeof name === "string" && path.dirname(name) === rootDir &&
          path.basename(name).startsWith("workspace-")) {
          child = name;
          childObservations += 1;
          if (childObservations === 2) modeTargetValidated = true;
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
  });
}
