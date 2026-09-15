import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { realpathSync } from "../src/realpath.js";
import { admitTempWorkspaceRoot, admitTempWorkspaceRootSync } from "../src/temp-workspace-admission.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

function nodeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`discovery ${code}`), { code });
}

function observeMutationAndCanonicalization() {
  const mutationFailure = new Error("unexpected root-discovery mutation");
  return {
    mkdir: vi.spyOn(fs, "mkdir").mockRejectedValue(mutationFailure),
    mkdirSync: vi.spyOn(fsSync, "mkdirSync").mockImplementation(() => { throw mutationFailure; }),
    canonicalize: vi.spyOn(realpathSync, "native"),
  };
}

for (const variant of ["async", "sync"] as const) {
  describe(`${variant} temp workspace root discovery`, () => {
    async function admit(rootDir: string) {
      return variant === "async"
        ? await admitTempWorkspaceRoot(rootDir)
        : admitTempWorkspaceRootSync(rootDir);
    }

    it("keeps an existing canonical root on its single strict bigint probe", async () => {
      const rootDir = await tempRoot("fs-safe-root-discovery-existing-");
      const lstat = vi.spyOn(fsSync, "lstatSync");
      const observations = observeMutationAndCanonicalization();
      expect((await admit(rootDir)).dir).toBe(rootDir);
      expect(lstat.mock.calls).toEqual([[rootDir, { bigint: true }]]);
      expect(observations.canonicalize.mock.calls).toEqual([[rootDir]]);
      expect(observations.mkdir).not.toHaveBeenCalled();
      expect(observations.mkdirSync).not.toHaveBeenCalled();
    });

    it.each(["quiet", "throwing-adapter"] as const)(
      "uses ordered quiet ancestor probes with a %s filesystem", async (adapter) => {
        const base = await tempRoot("fs-safe-root-discovery-missing-");
        const first = path.join(base, "one");
        const second = path.join(first, "two");
        const rootDir = path.join(second, "three");
        const lstat = fsSync.lstatSync.bind(fsSync);
        const canonicalize = realpathSync.native.bind(realpathSync);
        const probes: unknown[][] = [];
        let discovering = true;
        vi.spyOn(fsSync, "lstatSync").mockImplementation((name, options) => {
          if (discovering) probes.push([name, options]);
          if (adapter === "throwing-adapter" && options?.throwIfNoEntry === false) {
            return lstat(name, { bigint: true });
          }
          return lstat(name, options);
        });
        vi.spyOn(realpathSync, "native").mockImplementation((name) => {
          discovering = false;
          return canonicalize(name);
        });
        const mkdir = vi.spyOn(fs, "mkdir");
        const mkdirSync = vi.spyOn(fsSync, "mkdirSync");
        expect((await admit(rootDir)).dir).toBe(rootDir);
        expect(probes).toEqual([
          [rootDir, { bigint: true }],
          [second, { bigint: true, throwIfNoEntry: false }],
          [first, { bigint: true, throwIfNoEntry: false }],
          [base, { bigint: true, throwIfNoEntry: false }],
        ]);
        const used = variant === "async" ? mkdir : mkdirSync;
        const unused = variant === "async" ? mkdirSync : mkdir;
        expect(used.mock.calls).toEqual([first, second, rootDir].map((dir) => [dir, { mode: 0o700 }]));
        expect(unused).not.toHaveBeenCalled();
        for (const dir of [first, second, rootDir]) {
          const stat = lstat(dir, { bigint: true });
          expect(stat.isDirectory()).toBe(true);
          expect(stat.isSymbolicLink()).toBe(false);
          if (process.platform !== "win32") expect(stat.mode & 0o7777n).toBe(0o700n);
        }
      },
    );

    it.each(["ENOTDIR", "EACCES", "EIO"] as const)(
      "preserves %s at both strict and quiet discovery boundaries", async (code) => {
        const base = await tempRoot("fs-safe-root-discovery-error-");
        const parent = path.join(base, "parent");
        const rootDir = path.join(parent, "root");
        const failure = nodeError(code);
        const observations = observeMutationAndCanonicalization();
        const lstat = vi.spyOn(fsSync, "lstatSync");
        for (const later of [false, true]) {
          lstat.mockReset().mockImplementation((name) => {
            if (later && name === rootDir) throw nodeError("ENOENT");
            throw failure;
          });
          await expect(admit(rootDir)).rejects.toBe(failure);
          expect(lstat.mock.calls).toEqual([
            [rootDir, { bigint: true }],
            ...(later ? [[parent, { bigint: true, throwIfNoEntry: false }]] : []),
          ]);
        }
        expect(observations.canonicalize).not.toHaveBeenCalled();
        expect(observations.mkdir).not.toHaveBeenCalled();
        expect(observations.mkdirSync).not.toHaveBeenCalled();
      },
    );

    it.each([["initial", undefined], ["initial", null], ["later", null]] as const)(
      "does not treat a malformed %s observation (%s) as missing", async (phase, value) => {
        const base = await tempRoot("fs-safe-root-discovery-malformed-");
        const rootDir = path.join(base, "parent", "root");
        const observations = observeMutationAndCanonicalization();
        const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation((name) => {
          if (phase === "later" && name === rootDir) throw nodeError("ENOENT");
          return value as never;
        });
        await expect(admit(rootDir)).rejects.toBeInstanceOf(TypeError);
        expect(lstat).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2);
        expect(observations.canonicalize).not.toHaveBeenCalled();
        expect(observations.mkdir).not.toHaveBeenCalled();
        expect(observations.mkdirSync).not.toHaveBeenCalled();
      },
    );

    it.each([0, 2])("preserves strict volume-root failure after %i missing levels", async (depth) => {
      const volumeRoot = path.parse(path.resolve(".")).root;
      const parent = path.join(volumeRoot, "fs-safe-discovery-parent");
      const rootDir = depth === 0 ? volumeRoot : path.join(parent, "root");
      const failure = nodeError("ENOENT");
      const observations = observeMutationAndCanonicalization();
      const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation((name) => {
        if (name === volumeRoot) throw failure;
        if (name === rootDir) throw nodeError("ENOENT");
        return undefined;
      });
      await expect(admit(rootDir)).rejects.toBe(failure);
      expect(lstat.mock.calls).toEqual([
        ...(depth === 0 ? [] : [
          [rootDir, { bigint: true }],
          [parent, { bigint: true, throwIfNoEntry: false }],
        ]),
        [volumeRoot, { bigint: true }],
      ]);
      expect(observations.canonicalize).not.toHaveBeenCalled();
      expect(observations.mkdir).not.toHaveBeenCalled();
      expect(observations.mkdirSync).not.toHaveBeenCalled();
    });
  });
}
