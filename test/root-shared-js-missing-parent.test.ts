import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureFsSafeNative,
  __resetFsSafeNativeConfigForTest,
} from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import * as context from "../src/root-context.js";
import * as rootPath from "../src/root-path.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { observeMutationAuthorizations } from "./helpers/root-shared-js-admission.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const describeNode = describe.skipIf(Boolean(process.versions.bun));

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describeNode("shared JavaScript missing-parent admission", () => {
  it("keeps ineligible missing parents on depth-sensitive component admission", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-missing-parent-deopt-");
    const safe = await root(directory);
    const counts = observeMutationAuthorizations();
    const observed: number[] = [];
    let previous = 0;
    const outsidePolicy = path.join(path.dirname(directory), "outside-policy", "denied");

    for (const depth of [1, 8]) {
      const target = path.join(
        directory,
        `missing-${depth}`,
        ...Array.from({ length: depth - 1 }, (_, index) => `d${index}`),
        "value",
      );
      const opened = await safe.openWritable(path.relative(directory, target), {
        writeMode: "update",
        denyMutations: { prefixes: [outsidePolicy] },
        mutationSymlinks: "reject",
      });
      await opened.handle.close();
      const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
      observed.push(total - previous);
      previous = total;
    }

    expect(observed[0]).toBeGreaterThan(2);
    expect(observed[1]).toBeGreaterThan(observed[0]!);
  });

  it.each(["off", "require"] as const)(
    "keeps eligible ordinary missing-parent admission bounded in %s mode",
    async (mode) => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot(`fs-safe-shared-policy-receipt-${mode}-`);
      const safe = await root(directory);
      let probes = 0;
      let reusedProbes = 0;
      let sharedAuthorizes = 0;
      let successfulAdvances = 0;
      const counts = observeMutationAuthorizations({
        afterSharedProbe(_request, reused) {
          probes += 1;
          if (reused) reusedProbes += 1;
        },
        beforeSharedAuthorize() {
          sharedAuthorizes += 1;
        },
        afterSharedAdvance(advanced) {
          if (advanced) successfulAdvances += 1;
        },
      });
      const resolve = vi.spyOn(context, "resolvePathInRoot");
      const lstat = vi.spyOn(fsSync, "lstatSync");
      const authorizations: number[] = [];
      const sharedAuthorizations: number[] = [];
      const sharedProbes: number[] = [];
      const sharedReuses: number[] = [];
      const advances: number[] = [];
      const resolutions: number[] = [];
      const observations: number[] = [];
      let previous = 0;

      for (const depth of [1, 8, 32]) {
        const target = path.join(
          directory,
          `receipt-${mode}-${depth}`,
          ...Array.from({ length: depth - 1 }, (_, index) => `d${index}`),
          "value",
        );
        resolve.mockClear();
        lstat.mockClear();
        const opened = await safe.openWritable(path.relative(directory, target), {
          writeMode: "update",
          denyMutations: { prefixes: [path.join(directory, "denied")] },
          mutationSymlinks: "reject",
        });
        await opened.handle.close();
        expect((await fs.lstat(target)).isFile()).toBe(true);
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        authorizations.push(total - previous);
        previous = total;
        sharedAuthorizations.push(sharedAuthorizes);
        sharedProbes.push(probes);
        sharedReuses.push(reusedProbes);
        advances.push(successfulAdvances);
        sharedAuthorizes = 0;
        probes = 0;
        reusedProbes = 0;
        successfulAdvances = 0;
        resolutions.push(resolve.mock.calls.length);
        observations.push(lstat.mock.calls.length);
      }

      expect(new Set(authorizations).size).toBe(1);
      expect(new Set(resolutions).size).toBe(1);
      expect(sharedAuthorizations).toEqual([1, 1, 1]);
      expect(sharedProbes).toEqual([1, 8, 32]);
      expect(sharedReuses).toEqual([0, 7, 31]);
      expect(advances).toEqual([1, 8, 32]);
      expect(authorizations[0]).toBeGreaterThan(0);
      expect(resolutions[0]).toBeGreaterThan(0);
      expect(observations[2]!).toBeLessThan(observations[1]! * 6);
    },
  );

  it.each(["off", "require"] as const)(
    "keeps mixed existing/missing parent resolution bounded in %s mode",
    async (mode) => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot(`fs-safe-shared-policy-mixed-${mode}-`);
      const safe = await root(directory);
      const resolve = vi.spyOn(context, "resolvePathInRoot");
      const resolutions: number[] = [];

      for (const depth of [8, 32]) {
        const parts = Array.from({ length: depth }, (_, index) => `d${depth}-${index}`);
        await fs.mkdir(path.join(directory, ...parts.slice(0, depth / 2)), { recursive: true });
        const relative = path.join(...parts, "value");
        resolve.mockClear();
        const opened = await safe.openWritable(relative, {
          writeMode: "update",
          denyMutations: { prefixes: [path.join(directory, "denied")] },
          mutationSymlinks: "reject",
        });
        await opened.handle.close();
        resolutions.push(resolve.mock.calls.length);
        expect((await fs.lstat(path.join(directory, relative))).isFile()).toBe(true);
      }

      expect(resolutions[0]).toBeGreaterThan(0);
      expect(resolutions[1]).toBe(resolutions[0]);
    },
  );

  it.each(["off", "require"] as const)(
    "uses one guarded mkdir below an exact existing parent at every depth in %s mode",
    async (mode) => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot(`fs-safe-shared-policy-mkdir-parent-${mode}-`);
      const safe = await root(directory);
      const resolve = vi.spyOn(context, "resolvePathInRoot");
      const mkdir = vi.spyOn(fs, "mkdir");
      const resolutions: number[] = [];
      const mkdirs: number[] = [];

      for (const depth of [1, 8, 32]) {
        const parent = path.join(
          directory,
          `existing-${depth}`,
          ...Array.from({ length: depth - 1 }, (_, index) => `d${index}`),
        );
        await fs.mkdir(parent, { recursive: true });
        const target = path.join(parent, "value");
        resolve.mockClear();
        mkdir.mockClear();
        await safe.mkdir(path.relative(directory, target), {
          denyMutations: { prefixes: [path.join(directory, "denied")] },
          mutationSymlinks: "reject",
        });
        resolutions.push(resolve.mock.calls.length);
        mkdirs.push(mkdir.mock.calls.length);
        expect((await fs.lstat(target)).isDirectory()).toBe(true);
      }

      expect(new Set(resolutions).size).toBe(1);
      expect(mkdirs).toEqual([1, 1, 1]);
    },
  );

  it.each([
    "openWritable",
    "append",
    "mkdir",
    "write-overwrite",
    "write-exclusive",
    "create",
  ] as const)("uses the missing-parent receipt walk for %s", async (operation) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot(`fs-safe-shared-policy-receipt-${operation}-`);
    const safe = await root(directory);
    const relative = path.join("one", "two", "three", "value");
    const target = path.join(directory, relative);
    const options = {
      denyMutations: { prefixes: [path.join(directory, "denied")] },
      mutationSymlinks: "reject" as const,
    };

    if (operation === "openWritable") {
      const opened = await safe.openWritable(relative, { ...options, writeMode: "update" });
      await opened.handle.close();
    } else if (operation === "append") {
      await safe.append(relative, "payload", { ...options, durable: false });
    } else if (operation === "mkdir") {
      await safe.mkdir(relative, options);
    } else if (operation === "write-overwrite") {
      await safe.write(relative, Buffer.from("payload"), {
        ...options,
        durable: false,
        overwrite: true,
        renameIdentity: "verify-content-with-lock",
      });
    } else if (operation === "write-exclusive") {
      await safe.write(relative, Buffer.from("payload"), {
        ...options,
        durable: false,
        overwrite: false,
        renameIdentity: "verify-content-with-lock",
      });
    } else {
      await safe.create(relative, Buffer.from("payload"), {
        ...options,
        durable: false,
        renameIdentity: "verify-content-with-lock",
      });
    }

    const stat = await fs.lstat(target);
    expect(stat.isDirectory()).toBe(operation === "mkdir");
    if (operation !== "mkdir" && operation !== "openWritable") {
      expect(await fs.readFile(target, "utf8")).toBe("payload");
    }
  });

  it(
    "deopts an EEXIST parent collision to full admission",
    async () => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-shared-policy-receipt-eexist-");
      const safe = await root(directory);
      const resolve = vi.spyOn(context, "resolvePathInRoot");
      const options = {
        writeMode: "update" as const,
        denyMutations: { prefixes: [path.join(directory, "denied")] },
        mutationSymlinks: "reject" as const,
      };
      const ordinary = await safe.openWritable(path.join("ordinary", "one", "two", "value"), options);
      await ordinary.handle.close();
      const ordinaryResolutions = resolve.mock.calls.length;
      resolve.mockClear();

      const mkdir = fs.mkdir.bind(fs);
      let raced = false;
      vi.spyOn(fs, "mkdir").mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
        if (!raced && String(args[0]) === path.join(directory, "collision")) {
          raced = true;
          await mkdir(path.join(directory, "collision"));
          throw Object.assign(new Error("concurrent directory"), { code: "EEXIST" });
        }
        return await mkdir(...args);
      }) as typeof fs.mkdir);
      const collided = await safe.openWritable(path.join("collision", "one", "two", "value"), options);
      await collided.handle.close();

      expect(raced).toBe(true);
      expect(resolve.mock.calls.length).toBeGreaterThan(ordinaryResolutions);
      expect((await fs.lstat(path.join(directory, "collision/one/two/value"))).isFile())
        .toBe(true);
    },
  );

  it("reclassifies an exact-parent file collision without a second mutation", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-exact-parent-collision-");
    const parent = path.join(directory, "existing");
    const target = path.join(parent, "value");
    await fs.mkdir(parent);
    const safe = await root(directory);
    const realMkdir = fs.mkdir.bind(fs);
    let raced = false;
    vi.spyOn(fs, "mkdir").mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
      if (!raced && String(args[0]) === target) {
        raced = true;
        await fs.writeFile(target, "collision");
        throw Object.assign(new Error("concurrent file"), { code: "EEXIST" });
      }
      return await realMkdir(...args);
    }) as typeof fs.mkdir);

    await expect(safe.mkdir(path.relative(directory, target), {
      denyMutations: { prefixes: [path.join(directory, "denied")] },
      mutationSymlinks: "reject",
    })).rejects.toMatchObject({ code: "not-file" });

    expect(raced).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("collision");
  });

  it("keeps a live mkdir authority callback ahead of exact-parent mutation", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-exact-parent-authority-");
    const parent = path.join(directory, "existing");
    const target = path.join(parent, "value");
    await fs.mkdir(parent);
    const safe = await root(directory);
    const revoked = new Error("authority revoked");
    let calls = 0;

    await expect(safe.mkdir(path.relative(directory, target), {
      denyMutations: { prefixes: [path.join(directory, "denied")] },
      mutationSymlinks: "reject",
      assertBeforeMutation() {
        calls += 1;
        throw revoked;
      },
    })).rejects.toBe(revoked);

    expect(calls).toBe(1);
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

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

  it(
    "rechecks a deny-policy spelling that appears during the receipt walk",
    async () => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-shared-policy-receipt-deny-appearance-");
      const denied = path.join(directory, "deny-route");
      const first = path.join(directory, "one");
      let appeared = false;
      observeMutationAuthorizations({
        afterSharedAdvance(advanced) {
          if (appeared || !advanced) return;
          appeared = true;
          fsSync.symlinkSync(first, denied, process.platform === "win32" ? "junction" : "dir");
        },
      });
      const safe = await root(directory);

      await expect(safe.openWritable(path.join("one", "two", "value"), {
        writeMode: "update",
        denyMutations: { prefixes: [denied] },
        mutationSymlinks: "reject",
      })).rejects.toMatchObject({ code: "denied-path" });

      expect(appeared).toBe(true);
      expect(await fs.readdir(first)).toEqual([]);
    },
  );

  it(
    "rejects an exact parent replacement before reusing its receipt",
    async () => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-shared-policy-receipt-parent-swap-");
      const first = path.join(directory, "one");
      const saved = path.join(directory, "saved");
      let replaced = false;
      observeMutationAuthorizations({
        afterSharedAdvance(advanced) {
          if (replaced || !advanced) return;
          replaced = true;
          fsSync.renameSync(first, saved);
          fsSync.mkdirSync(first);
        },
      });
      const safe = await root(directory);

      await expect(safe.openWritable(path.join("one", "two", "value"), {
        writeMode: "update",
        denyMutations: { prefixes: [path.join(directory, "denied")] },
        mutationSymlinks: "reject",
      })).rejects.toMatchObject({ code: "path-mismatch" });

      expect(replaced).toBe(true);
      expect(await fs.readdir(first)).toEqual([]);
      expect(await fs.readdir(saved)).toEqual([]);
    },
  );

  it.each(["symlink", "hardlink"] as const)(
    "retains the final %s check after a missing-parent receipt walk",
    async (attack) => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot(`fs-safe-shared-policy-receipt-${attack}-`);
      const target = path.join(directory, "one", "two", "value");
      const other = path.join(directory, "other");
      let injected = false;
      observeMutationAuthorizations({
        afterAuthorize(request) {
          if (injected || request.phase !== "parent" ||
            !fsSync.existsSync(path.dirname(target))) return;
          injected = true;
          fsSync.writeFileSync(other, "injected");
          if (attack === "symlink") fsSync.symlinkSync(other, target, "file");
          else fsSync.linkSync(other, target);
        },
      });
      const safe = await root(directory);

      await expect(safe.openWritable(path.join("one", "two", "value"), {
        writeMode: "update",
        denyMutations: { prefixes: [path.join(directory, "denied")] },
        mutationSymlinks: "reject",
      })).rejects.toMatchObject({ code: attack });

      expect(injected).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe("injected");
      expect(await fs.readFile(other, "utf8")).toBe("injected");
    },
  );
});
