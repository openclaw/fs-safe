import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root, type Root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

const operations = [
  { name: "mkdir", run: (scoped: Root) => scoped.mkdir("blocked/child") },
  { name: "resolve", run: (scoped: Root) => scoped.resolve("blocked/child") },
  { name: "write", run: (scoped: Root) => scoped.write("blocked/child", "value") },
];

describe.each(operations)("Root $name traversal permission errors", ({ run }) => {
  it.each(["EACCES", "EPERM"])("reports %s as operational without creating the target", async code => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-traversal-");
    const blocked = path.join(directory, "blocked");
    await fs.mkdir(blocked);
    const scoped = await root(directory, { mutationSymlinks: "reject" });
    const deniedPath = path.join(blocked, "child");
    const failure = Object.assign(new Error(`${code}: traversal denied`), { code, path: deniedPath });
    const lstat = fsSync.lstatSync;
    vi.spyOn(fsSync, "lstatSync").mockImplementation(((candidate, options) => {
      if (String(candidate) === deniedPath) throw failure;
      return lstat(candidate, options as never);
    }) as typeof fsSync.lstatSync);

    const asyncLstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation((async (candidate, options) => {
      if (String(candidate) === deniedPath) throw failure;
      return asyncLstat(candidate, options as never);
    }) as typeof fs.lstat);

    await expect(run(scoped)).rejects.toMatchObject({
      code: "permission-denied",
      category: "operational",
      cause: failure,
      message: expect.stringContaining(deniedPath),
    });
    expect(await fs.readdir(blocked)).toEqual([]);
  });
});
