import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureFsSafeNative,
  __resetFsSafeNativeConfigForTest,
} from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import * as rootPath from "../src/root-path.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const describeNode = describe.skipIf(Boolean(process.versions.bun));

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describeNode("root mkdir post-create admission", () => {
  it.each(["symlink", "file", "observation"] as const)(
    "handles an exact-parent post-create %s failure without retrying mkdir",
    async (failure) => {
      const outcomes: string[] = [];
      const caughtErrors: unknown[] = [];
      for (const forced of [false, true]) {
        configureFsSafeNative({ mode: "off" });
        const directory = await tempRoot(`fs-safe-mkdir-post-${failure}-${forced}-`);
        const parent = path.join(directory, "existing");
        const target = path.join(parent, "value");
        const replacement = path.join(directory, "replacement");
        await fs.mkdir(parent);
        if (failure === "symlink") await fs.mkdir(replacement);
        const safe = await root(directory);
        const realMkdir = fs.mkdir.bind(fs);
        const realLstat = fsSync.lstatSync.bind(fsSync);
        let targetAttempts = 0;
        let targetMutations = 0;
        let failObservation = false;
        let observationFaults = 0;
        const resolve = failure === "observation"
          ? vi.spyOn(rootPath, "resolveRootPath")
          : undefined;
        const mkdir = vi.spyOn(fs, "mkdir").mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
          const targetsValue = String(args[0]) === target;
          if (targetsValue) targetAttempts += 1;
          const result = await realMkdir(...args);
          if (!targetsValue) return result;
          targetMutations += 1;
          if (failure !== "observation") {
            await fs.rm(target, { recursive: true });
            if (failure === "symlink") {
              await fs.symlink(replacement, target, process.platform === "win32" ? "junction" : "dir");
            } else await fs.writeFile(target, "replacement");
          } else {
            resolve?.mockClear();
            failObservation = true;
          }
          return result;
        }) as typeof fs.mkdir);
        const lstat = failure === "observation"
          ? vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
            if (failObservation && String(args[0]) === target) {
              failObservation = false;
              observationFaults += 1;
              throw Object.assign(new Error("transient observation"), { code: "EIO" });
            }
            return realLstat(...args);
          }) as typeof fsSync.lstatSync)
          : undefined;
        let outcome = "ok";
        let caughtError: unknown;
        try {
          await safe.mkdir(path.relative(directory, target), {
            denyMutations: { prefixes: [path.join(directory, "denied")] },
            mutationSymlinks: "reject",
            ...(forced ? { assertBeforeMutation() {} } : {}),
          });
        } catch (error) {
          caughtError = error;
          outcome = (error as { code?: string }).code ?? "error";
        } finally {
          mkdir.mockRestore();
          lstat?.mockRestore();
        }
        expect(targetAttempts).toBe(1);
        expect(targetMutations).toBe(1);
        if (failure === "symlink") expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
        else if (failure === "file") expect(await fs.readFile(target, "utf8")).toBe("replacement");
        else expect((await fs.lstat(target)).isDirectory()).toBe(true);
        if (failure === "observation") {
          expect(observationFaults).toBe(1);
          expect(resolve).toHaveBeenCalledTimes(1);
        }
        resolve?.mockRestore();
        outcomes.push(outcome);
        caughtErrors.push(caughtError);
      }
      if (failure === "observation") {
        expect(outcomes).toEqual(["ok", "path-alias"]);
        expect(caughtErrors[0]).toBeUndefined();
        expect(caughtErrors[1]).toMatchObject({ code: "path-alias", cause: { code: "EIO" } });
      } else {
        expect(outcomes).toEqual(failure === "symlink"
          ? ["symlink", "symlink"] : ["not-file", "not-file"]);
      }
    },
  );
});
