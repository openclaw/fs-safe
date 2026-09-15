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

  it.runIf(process.platform === "win32").each(["off", "require"] as const)(
    "keeps eligible Windows missing-parent admission bounded in %s mode",
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

  it.runIf(process.platform === "win32").each([
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

  it.runIf(process.platform === "win32")(
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

  it.runIf(process.platform === "win32")(
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
          fsSync.symlinkSync(first, denied, "junction");
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

  it.runIf(process.platform === "win32")(
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

  it.runIf(process.platform === "win32").each(["symlink", "hardlink"] as const)(
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
