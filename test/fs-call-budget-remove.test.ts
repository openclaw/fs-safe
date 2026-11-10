import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { __loadBundledNativeForTest } from "../src/native.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe("recursive removal observation budgets", () => {
  let nativeRemoval: ReturnType<typeof __loadBundledNativeForTest> | undefined;
  try { if (process.platform !== "win32") nativeRemoval = __loadBundledNativeForTest(); }
  catch { /* The fallback budget runs without an installed binding. */ }
  it.each(["off", ...(nativeRemoval?.openRootRemovalDirectory ? ["require"] : [])] as const)("keeps every %s directory fence while avoiding repeated BigIntStats allocation", async mode => {
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-remove-call-budget-");
    const safe = await root(directory);
    const tree = path.join(safe.rootReal, "tree");
    await fs.mkdir(tree);
    await fs.writeFile(path.join(tree, "leaf"), "value");
    if (mode === "require") {
      const parent = fsSync.openSync(safe.rootReal, fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0));
      let available: boolean;
      try { available = nativeRemoval?.ownedTreeRemovalAvailable?.(parent) === true; }
      finally { fsSync.closeSync(parent); }
      // The export can exist even when the kernel cannot confine recursion.
      if (!available) {
        try {
          await expect(safe.remove("tree", { recursive: true })).rejects.toMatchObject({ code: "helper-unavailable" });
          expect(await fs.readFile(path.join(tree, "leaf"), "utf8")).toBe("value");
        } finally { configureFsSafeNative({ mode: "auto" }); }
        return;
      }
    }
    const boundaries = new Set([safe.rootReal, tree]);
    const observations = { exact: 0, numeric: 0, canonical: 0 };
    const lstat = fsSync.lstatSync.bind(fsSync);
    const realpath = fsSync.realpathSync.native;
    const safeIds = [...boundaries].every(boundary => {
      const stat = lstat(boundary, { bigint: true });
      return stat.dev > 0n && stat.ino > 0n &&
        stat.dev <= BigInt(Number.MAX_SAFE_INTEGER) && stat.ino <= BigInt(Number.MAX_SAFE_INTEGER);
    });
    const statSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      if (boundaries.has(String(args[0]))) {
        observations[(args[1] as { bigint?: boolean } | undefined)?.bigint ? "exact" : "numeric"]++;
      }
      return lstat(...args);
    }) as typeof fsSync.lstatSync);
    const asyncLstat = fs.lstat.bind(fs);
    const asyncStatSpy = vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      if (boundaries.has(String(args[0]))) {
        observations[(args[1] as { bigint?: boolean } | undefined)?.bigint ? "exact" : "numeric"]++;
      }
      return asyncLstat(...args);
    }) as typeof fs.lstat);
    const realpathSpy = vi.spyOn(fsSync.realpathSync, "native").mockImplementation((...args) => {
      if (boundaries.has(String(args[0]))) observations.canonical++;
      return realpath(...args);
    });
    try {
      await safe.remove("tree", { recursive: true });
      const expected = mode === "require"
        ? { exact: 3, numeric: 13, canonical: 14 }
        : { exact: 6, numeric: 20, canonical: 21 };
      if (safeIds) {
        expect(observations).toEqual(expected);
      } else {
        expect(observations.canonical).toBe(expected.canonical);
        expect(observations.exact + observations.numeric).toBeGreaterThanOrEqual(expected.exact + expected.numeric);
      }
    } finally {
      statSpy.mockRestore();
      asyncStatSpy.mockRestore();
      realpathSpy.mockRestore();
      configureFsSafeNative({ mode: "auto" });
    }
  });
});
