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

describeNode("shared JavaScript complete-parent admission", () => {
  it("keeps complete-parent authorization count constant with route depth", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-complete-parent-");
    const safe = await root(directory);
    const counts = observeMutationAuthorizations();
    const observed: number[] = [];
    let previous = 0;

    for (const depth of [1, 8, 32]) {
      const parent = path.join(
        directory,
        `depth-${depth}`,
        ...Array.from({ length: depth - 1 }, (_, index) => `d${index}`),
      );
      const target = path.join(parent, "value");
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(target, "original");
      const opened = await safe.openWritable(path.relative(directory, target), {
        writeMode: "update",
        denyMutations: { prefixes: [path.join(directory, "denied")] },
        mutationSymlinks: "reject",
      });
      await opened.handle.close();
      const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
      observed.push(total - previous);
      previous = total;
    }

    expect(observed).toEqual([2, 2, 2]);
  });

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

  it("keeps authority callbacks on the component-walk route", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-callback-deopt-");
    const safe = await root(directory);
    const counts = observeMutationAuthorizations();
    const observed: number[] = [];
    let previous = 0;

    for (const depth of [1, 8]) {
      const parent = path.join(
        directory,
        `callback-${depth}`,
        ...Array.from({ length: depth - 1 }, (_, index) => `d${index}`),
      );
      const target = path.join(parent, "value");
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(target, "original");
      const callback = vi.fn();
      const opened = await safe.openWritable(path.relative(directory, target), {
        writeMode: "replace",
        denyMutations: { prefixes: [path.join(directory, "denied")] },
        mutationSymlinks: "reject",
        assertBeforeMutation: callback,
      });
      await opened.handle.close();
      expect(callback).toHaveBeenCalledTimes(1);
      const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
      observed.push(total - previous);
      previous = total;
    }

    expect(observed[1]).toBeGreaterThan(observed[0]!);
  });

  it("invalidates a complete-parent guard after exact parent replacement", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-fast-parent-swap-");
    const parent = path.join(directory, "parent");
    const saved = path.join(directory, "saved");
    const target = path.join(parent, "value");
    await fs.mkdir(parent);
    await fs.writeFile(target, "original");
    let replaced = false;
    observeMutationAuthorizations({
      afterAuthorize(request) {
        if (replaced || request.phase !== "parent") return;
        replaced = true;
        fsSync.renameSync(parent, saved);
        fsSync.mkdirSync(parent);
      },
    });
    const open = vi.spyOn(fs, "open");
    const safe = await root(directory);

    await expect(safe.openWritable(path.relative(directory, target), {
      writeMode: "update",
      denyMutations: { prefixes: [path.join(directory, "denied")] },
      mutationSymlinks: "reject",
    })).rejects.toMatchObject({ code: "path-mismatch" });

    expect(replaced).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(await fs.readdir(parent)).toEqual([]);
    expect(await fs.readFile(path.join(saved, "value"), "utf8")).toBe("original");
  });

  it.skipIf(process.platform === "win32")(
    "invalidates a complete-parent guard after canonical parent replacement",
    async () => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-shared-policy-fast-parent-alias-");
      const parent = path.join(directory, "parent");
      const saved = path.join(directory, "saved");
      const target = path.join(parent, "value");
      await fs.mkdir(parent);
      await fs.writeFile(target, "original");
      let replaced = false;
      observeMutationAuthorizations({
        afterAuthorize(request) {
          if (replaced || request.phase !== "parent") return;
          replaced = true;
          fsSync.renameSync(parent, saved);
          fsSync.symlinkSync(saved, parent, "dir");
        },
      });
      const open = vi.spyOn(fs, "open");
      const safe = await root(directory);

      await expect(safe.openWritable(path.relative(directory, target), {
        writeMode: "update",
        denyMutations: { prefixes: [path.join(directory, "denied")] },
        mutationSymlinks: "reject",
      })).rejects.toMatchObject({ code: "path-mismatch" });

      expect(replaced).toBe(true);
      expect(open).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(saved, "value"), "utf8")).toBe("original");
    },
  );

  it.skipIf(process.platform === "win32")(
    "invalidates a complete-parent guard after exact root replacement",
    async () => {
      configureFsSafeNative({ mode: "off" });
      const directory = await tempRoot("fs-safe-shared-policy-fast-root-swap-");
      const saved = `${directory}-saved`;
      const parent = path.join(directory, "parent");
      const target = path.join(parent, "value");
      await fs.mkdir(parent);
      await fs.writeFile(target, "original");
      let replaced = false;
      observeMutationAuthorizations({
        afterAuthorize(request) {
          if (replaced || request.phase !== "parent") return;
          replaced = true;
          fsSync.renameSync(directory, saved);
          fsSync.mkdirSync(directory);
          fsSync.mkdirSync(path.join(directory, "parent"));
        },
      });
      const open = vi.spyOn(fs, "open");
      const safe = await root(directory);

      try {
        await expect(safe.openWritable(path.relative(directory, target), {
          writeMode: "update",
          denyMutations: { prefixes: [path.join(directory, "denied")] },
          mutationSymlinks: "reject",
        })).rejects.toMatchObject({ code: "path-mismatch" });
        expect(replaced).toBe(true);
        expect(open).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(saved, "parent/value"), "utf8")).toBe("original");
      } finally {
        if (replaced) {
          await fs.rm(directory, { recursive: true, force: true });
          await fs.rename(saved, directory);
        }
      }
    },
  );

  it("invalidates an unexpectedly appearing child after complete-parent admission", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-fast-child-appearance-");
    const parent = path.join(directory, "parent");
    const target = path.join(parent, "value");
    await fs.mkdir(parent);
    let appeared = false;
    observeMutationAuthorizations({
      afterAuthorize(request) {
        if (appeared || request.phase !== "parent") return;
        appeared = true;
        fsSync.writeFileSync(target, "injected");
      },
    });
    const open = vi.spyOn(fs, "open");
    const safe = await root(directory);

    await expect(safe.openWritable(path.relative(directory, target), {
      writeMode: "update",
      denyMutations: { prefixes: [path.join(directory, "denied")] },
      mutationSymlinks: "reject",
    })).rejects.toMatchObject({ code: "path-mismatch" });

    expect(appeared).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe("injected");
  });

  it("invalidates complete-parent evidence when native mode changes during admission", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-fast-mode-change-");
    const target = path.join(directory, "value");
    await fs.writeFile(target, "original");
    let changed = false;
    observeMutationAuthorizations({
      afterAuthorize(request) {
        if (changed || request.phase !== "parent") return;
        changed = true;
        configureFsSafeNative({ mode: "auto" });
      },
    });
    const open = vi.spyOn(fs, "open");
    const safe = await root(directory);

    await expect(safe.openWritable(path.relative(directory, target), {
      writeMode: "update",
      denyMutations: { prefixes: [path.join(directory, "denied")] },
      mutationSymlinks: "reject",
    })).rejects.toMatchObject({ code: "path-mismatch" });

    expect(changed).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });

  it("preserves original-route denial before complete-parent dispatch", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-shared-policy-fast-denial-order-");
    const target = path.join(directory, "value");
    const unrelated = path.join(directory, "unrelated");
    const deniedAlias = path.join(directory, "denied-alias");
    await fs.writeFile(target, "original");
    await fs.writeFile(unrelated, "unrelated");
    await fs.symlink(unrelated, deniedAlias, "file");
    let retargeted = false;
    observeMutationAuthorizations({
      async beforeAuthorize(request) {
        if (retargeted || request.phase !== "parent") return;
        retargeted = true;
        await fs.unlink(deniedAlias);
        await fs.symlink(target, deniedAlias, "file");
      },
    });
    const open = vi.spyOn(fs, "open");
    const safe = await root(directory);

    await expect(safe.openWritable(path.relative(directory, target), {
      writeMode: "update",
      denyMutations: { paths: [deniedAlias] },
    })).rejects.toMatchObject({ code: "denied-path" });

    expect(retargeted).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });
});
