import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureFsSafeNative,
  __resetFsSafeNativeConfigForTest,
} from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
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
