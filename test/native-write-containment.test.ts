import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
} from "../src/native.js";
import { root, type Root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

let bundledNativeAvailable = false;
try {
  __loadBundledNativeForTest();
  bundledNativeAvailable = true;
} catch {
  // Ordinary JavaScript-only CI legs intentionally have no host binding.
}

const tempDirs: string[] = [];

afterEach(async () => {
  __setFsSafeTestHooksForTest();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type WriteOperation = {
  label: string;
  run(safeRoot: Root, source: string): Promise<void>;
};

const overwriteOperations: WriteOperation[] = [
  {
    label: "copyIn",
    run: async (safeRoot, source) => await safeRoot.copyIn("data/nested/value.txt", source),
  },
  {
    label: "write default overwrite",
    run: async (safeRoot) => await safeRoot.write("data/nested/value.txt", "payload"),
  },
  {
    label: "write explicit overwrite",
    run: async (safeRoot) =>
      await safeRoot.write("data/nested/value.txt", "payload", { overwrite: true }),
  },
];

describe.runIf(bundledNativeAvailable)("native overwrite containment", () => {
  it.each(overwriteOperations)(
    "keeps $label parent creation descriptor-relative in default mode",
    async ({ run }) => {
      const base = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-native-write-containment-")),
      );
      tempDirs.push(base);
      const rootDir = path.join(base, "root");
      const outside = path.join(base, "outside");
      const parent = path.join(rootDir, "data");
      const movedParent = path.join(rootDir, "data-original");
      const source = path.join(base, "source.txt");
      await fs.mkdir(parent, { recursive: true });
      await fs.mkdir(outside);
      await fs.writeFile(source, "payload");

      let fallbackMutationReached = false;
      __setFsSafeTestHooksForTest({
        async beforeRootFallbackMutation(operation, targetPath) {
          if (operation !== "mkdir" || targetPath !== path.join(parent, "nested")) {
            return;
          }
          fallbackMutationReached = true;
          await fs.rename(parent, movedParent);
          await fs.symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
        },
      });

      const safeRoot = await root(rootDir);
      await expect(run(safeRoot, source)).resolves.toBeUndefined();

      expect(fallbackMutationReached).toBe(false);
      await expect(fs.readFile(path.join(parent, "nested/value.txt"), "utf8")).resolves.toBe(
        "payload",
      );
      await expect(fs.lstat(path.join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});

it("documents the bounded mode-off parent-mutation limitation", async () => {
  configureFsSafeNative({ mode: "off" });
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-fallback-write-containment-")),
  );
  tempDirs.push(base);
  const rootDir = path.join(base, "root");
  const outside = path.join(base, "outside");
  const parent = path.join(rootDir, "data");
  const source = path.join(base, "source.txt");
  await fs.mkdir(parent, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(source, "payload");

  let fallbackMutationReached = false;
  __setFsSafeTestHooksForTest({
    async beforeRootFallbackMutation(operation, targetPath) {
      if (operation !== "mkdir" || targetPath !== path.join(parent, "nested")) {
        return;
      }
      fallbackMutationReached = true;
      await fs.rename(parent, `${parent}-original`);
      await fs.symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
    },
  });

  const safeRoot = await root(rootDir);
  await expect(safeRoot.copyIn("data/nested/value.txt", source)).rejects.toBeTruthy();

  expect(fallbackMutationReached).toBe(true);
  await expect(fs.lstat(path.join(outside, "nested"))).resolves.toSatisfy((stat) =>
    stat.isDirectory()
  );
  await expect(fs.lstat(path.join(outside, "nested/value.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
