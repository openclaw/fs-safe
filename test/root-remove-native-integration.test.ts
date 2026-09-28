import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Dedicated native lanes build the addon. */ }
const { tempRoot } = useRealTempDirs();
afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
});

describe.runIf(native?.rootRemovalStat)("native Root removal", () => {
  function requireNative(): void {
    __setNativeLoaderForTest(() => native!);
    configureFsSafeNative({ mode: "require" });
  }

  it.each([false, true])("keeps outside data after a parent swap (recursive=%s)", async recursive => {
    requireNative();
    const directory = await tempRoot("fs-safe-native-remove-");
    const outside = await tempRoot("fs-safe-native-remove-outside-");
    await fs.mkdir(path.join(directory, "parent/tree"), { recursive: true });
    await fs.mkdir(path.join(outside, "tree"));
    await fs.writeFile(path.join(directory, "parent/tree/value"), "inside");
    await fs.writeFile(path.join(outside, "tree/value"), "outside");
    const scoped = await root(directory);
    let swapped = false;
    __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: async operation => {
      if (operation !== "remove" || swapped) return;
      swapped = true;
      await fs.rename(path.join(directory, "parent"), path.join(directory, "held"));
      await fs.symlink(outside, path.join(directory, "parent"), "dir");
    } });
    await expect(scoped.remove(recursive ? "parent/tree" : "parent/tree/value", { recursive }))
      .rejects.toMatchObject({ code: "path-mismatch" });
    expect(swapped).toBe(true);
    expect(await fs.readFile(path.join(outside, "tree/value"), "utf8")).toBe("outside");
  });

  it.each(["filesystem", "sorted"] as const)("preserves recursive policies and budgets (%s)", async order => {
    requireNative();
    const directory = await tempRoot("fs-safe-native-remove-policy-");
    await fs.mkdir(path.join(directory, "tree/nested"), { recursive: true });
    await fs.writeFile(path.join(directory, "tree/nested/value"), "preserve");
    const scoped = await root(directory);
    await expect(scoped.remove("tree", { recursive: true, order, denyMutations: { paths: [path.join(directory, "tree/nested/value")] } }))
      .rejects.toMatchObject({ code: "denied-path" });
    await expect(scoped.remove("tree", { recursive: true, order, maxEntries: 2 }))
      .rejects.toMatchObject({ code: "too-large" });
    expect(await fs.readFile(path.join(directory, "tree/nested/value"), "utf8")).toBe("preserve");
    await scoped.remove("tree", { recursive: true, order, maxEntries: 3 });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("fails closed before mutation when mount-bounded descent is unavailable", async () => {
    __setNativeLoaderForTest(() => ({ ...native!, ownedTreeRemovalAvailable: () => false }));
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("fs-safe-native-remove-unavailable-");
    await fs.mkdir(path.join(directory, "tree"));
    const scoped = await root(directory);
    await expect(scoped.remove("tree", { recursive: true })).rejects.toMatchObject({ code: "helper-unavailable" });
    expect(await fs.readdir(directory)).toEqual(["tree"]);
  });

  it("checks the retained ancestor identities after native unlink dispatch", async () => {
    const directory = await tempRoot("fs-safe-native-remove-after-");
    await fs.mkdir(path.join(directory, "ancestor/parent"), { recursive: true });
    await fs.writeFile(path.join(directory, "ancestor/parent/value"), "inside");
    const scoped = await root(directory);
    __setNativeLoaderForTest(() => ({ ...native!, rootRemovalUnlink(...args) {
      native!.rootRemovalUnlink!(...args);
      // Preserve the immediate parent's identity beneath a replaced ancestor.
      fsSync.renameSync(path.join(directory, "ancestor"), path.join(directory, "held"));
      fsSync.mkdirSync(path.join(directory, "ancestor"));
      fsSync.renameSync(path.join(directory, "held/parent"), path.join(directory, "ancestor/parent"));
    } }));
    configureFsSafeNative({ mode: "require" });
    await expect(scoped.remove("ancestor/parent/value", { force: true })).rejects.toMatchObject({ code: "path-mismatch" });
  });
});

it("does not silently use pathname removal with an incomplete required binding", async () => {
  __setNativeLoaderForTest(() => ({ closeOwnedFd() {} }) as unknown as NativeBinding);
  configureFsSafeNative({ mode: "require" });
  const directory = await tempRoot("fs-safe-remove-require-");
  await fs.writeFile(path.join(directory, "value"), "preserve");
  const scoped = await root(directory);
  await expect(scoped.remove("value")).rejects.toMatchObject({ code: "helper-unavailable" });
  expect(await fs.readFile(path.join(directory, "value"), "utf8")).toBe("preserve");
});
