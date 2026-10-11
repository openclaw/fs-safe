import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Native CI builds the binding. */ }
const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); __resetNativeLoaderForTest(); });

it.runIf(native?.mkdirChildBeneath && !process.versions.bun)("pins direct-child mkdir async resource counts in every native mode", () => {
  for (const operation of ["mkdir", "ensureRoot"]) {
    expect(() => execFileSync(process.execPath, ["scripts/native-call-budget-proof.mjs", "--resources-only", "--operation", operation], {
      cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", stdio: "pipe",
    })).not.toThrow();
  }
});

it.runIf(native?.mkdirOpenChildBeneath)("confines direct-child creation when Root is replaced at dispatch", async () => {
  configureFsSafeNative({ mode: "require" });
  const directory = await tempRoot("fs-safe-mkdir-root-swap-");
  const outside = await tempRoot("fs-safe-mkdir-outside-");
  const parked = `${directory}-parked`;
  const safe = await root(directory);
  __setNativeLoaderForTest(() => ({ ...native!, mkdirOpenChildBeneath(...args) {
    fs.renameSync(directory, parked);
    fs.symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
    return native!.mkdirOpenChildBeneath!(...args);
  } }));
  try {
    await expect(safe.mkdir("child")).rejects.toMatchObject({ code: "path-mismatch" });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.statSync(path.join(parked, "child")).isDirectory()).toBe(true);
  } finally {
    fs.unlinkSync(directory);
    fs.renameSync(parked, directory);
  }
});

it.runIf(native?.mkdirOpenChildBeneath)("rejects a replaced child while retaining the opened directory", async () => {
  configureFsSafeNative({ mode: "require" });
  const directory = await tempRoot("fs-safe-mkdir-child-swap-");
  const safe = await root(directory);
  __setNativeLoaderForTest(() => ({ ...native!, mkdirOpenChildBeneath(...args) {
    const child = native!.mkdirOpenChildBeneath!(...args);
    fs.renameSync(path.join(directory, "child"), path.join(directory, "held"));
    fs.mkdirSync(path.join(directory, "child"));
    return child;
  } }));
  await expect(safe.mkdir("child")).rejects.toMatchObject({ code: "path-mismatch" });
  expect(fs.readdirSync(directory)).toEqual(["child", "held"]);
});

it.runIf(native?.mkdirChildBeneath)("keeps existing direct-child aliases on their admitted target", async () => {
  const directory = await tempRoot("fs-safe-mkdir-alias-admission-");
  fs.mkdirSync(path.join(directory, "actual"));
  fs.symlinkSync(path.join(directory, "actual"), path.join(directory, "alias"),
    process.platform === "win32" ? "junction" : "dir");
  const safe = await root(directory);
  for (const mode of ["off", "require"] as const) {
    configureFsSafeNative({ mode });
    await safe.mkdir("alias");
    expect(fs.lstatSync(path.join(directory, "alias")).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(path.join(directory, "actual"))).toEqual([]);
  }
});
