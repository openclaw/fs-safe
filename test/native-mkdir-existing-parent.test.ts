import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { FsSafeError } from "../src/errors.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Native CI supplies the binding. */ }
const { tempRoot } = useRealTempDirs();
afterEach(() => { __resetNativeLoaderForTest(); __resetFsSafeNativeConfigForTest(); });

describe.runIf(native?.mkdirChildBeneath)("native mkdir with an existing parent", () => {
  it("rejects a parent replaced between its snapshot and beneath open", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("mkdir-parent-open-");
    const parent = path.join(directory, "parent");
    fs.mkdirSync(parent);
    const safe = await root(directory);
    let swapped = false;
    __setNativeLoaderForTest(() => ({ ...native!, openBeneath(...args) {
      if (!swapped && args[1] === "parent") {
        swapped = true;
        fs.renameSync(parent, path.join(directory, "held"));
        fs.mkdirSync(parent);
      }
      return native!.openBeneath!(...args);
    } }));
    await expect(safe.mkdir("parent/child")).rejects.toMatchObject({ code: "path-mismatch" });
    expect(swapped).toBe(true);
    expect(fs.readdirSync(parent)).toEqual([]);
    expect(fs.readdirSync(path.join(directory, "held"))).toEqual([]);
  });

  it("keeps mutation inside the retained parent when its name is replaced", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("mkdir-parent-dispatch-");
    const outside = await tempRoot("mkdir-parent-outside-");
    const parent = path.join(directory, "parent");
    const held = path.join(directory, "held");
    fs.mkdirSync(parent);
    const safe = await root(directory);
    const beforeCreate = () => {
      fs.renameSync(parent, held);
      fs.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
    };
    __setNativeLoaderForTest(() => ({ ...native!,
      ...(native!.mkdirOpenChildBeneath ? { mkdirOpenChildBeneath(...args: Parameters<NonNullable<NativeBinding["mkdirOpenChildBeneath"]>>) {
        beforeCreate();
        return native!.mkdirOpenChildBeneath!(...args);
      } } : { mkdirChildBeneath(...args: Parameters<NonNullable<NativeBinding["mkdirChildBeneath"]>>) {
        beforeCreate();
        return native!.mkdirChildBeneath!(...args);
      } }),
    }));
    await expect(safe.mkdir("parent/child")).rejects.toMatchObject({ code: expect.stringMatching(/^(path-mismatch|ENOENT)$/) });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.statSync(path.join(held, "child")).isDirectory()).toBe(true);
    fs.unlinkSync(parent);
  });

  it.runIf(native?.mkdirOpenChildBeneath)("rejects a replaced child after native creation", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("mkdir-nested-child-");
    const parent = path.join(directory, "parent");
    fs.mkdirSync(parent);
    const safe = await root(directory);
    __setNativeLoaderForTest(() => ({ ...native!, mkdirOpenChildBeneath(...args) {
      const child = native!.mkdirOpenChildBeneath!(...args);
      fs.renameSync(path.join(parent, "child"), path.join(parent, "held"));
      fs.mkdirSync(path.join(parent, "child"));
      return child;
    } }));
    await expect(safe.mkdir("parent/child")).rejects.toMatchObject({ code: "path-mismatch" });
  });

  it("preserves typed ENOTDIR when a file races into the child name", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("mkdir-nested-file-race-");
    const parent = path.join(directory, "parent");
    const target = path.join(parent, "child");
    fs.mkdirSync(parent);
    const safe = await root(directory);
    const replace = () => fs.writeFileSync(target, "raced file");
    __setNativeLoaderForTest(() => ({ ...native!,
      ...(native!.mkdirOpenChildBeneath ? { mkdirOpenChildBeneath(...args: Parameters<NonNullable<NativeBinding["mkdirOpenChildBeneath"]>>) {
        replace();
        return native!.mkdirOpenChildBeneath!(...args);
      } } : { mkdirChildBeneath(...args: Parameters<NonNullable<NativeBinding["mkdirChildBeneath"]>>) {
        replace();
        return native!.mkdirChildBeneath!(...args);
      } }),
    }));
    const failure = await safe.mkdir("parent/child").then(() => undefined, error => error);
    expect(failure).toBeInstanceOf(FsSafeError);
    expect(failure).toMatchObject({ code: "not-file" });
    if (failure.cause !== undefined || process.platform !== "win32") expect(failure.cause).toMatchObject({ code: "ENOTDIR" });
    expect(fs.readFileSync(target, "utf8")).toBe("raced file");
  });

  it("accepts repeated calls for an existing ordinary directory", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("mkdir-nested-existing-");
    fs.mkdirSync(path.join(directory, "parent"));
    const safe = await root(directory);
    await safe.mkdir("parent/child");
    await safe.mkdir(path.join("parent", "child"));
    expect(fs.readdirSync(path.join(directory, "parent"))).toEqual(["child"]);
  });

  it("retains in-root alias resolution and missing-parent creation", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("mkdir-nested-alias-");
    fs.mkdirSync(path.join(directory, "actual"));
    fs.symlinkSync(path.join(directory, "actual"), path.join(directory, "alias"), process.platform === "win32" ? "junction" : "dir");
    const safe = await root(directory);
    await safe.mkdir("alias/child");
    await safe.mkdir("new/parent/child");
    expect(fs.statSync(path.join(directory, "actual/child")).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(directory, "alias")).isSymbolicLink()).toBe(true);
    expect(fs.statSync(path.join(directory, "new/parent/child")).isDirectory()).toBe(true);
  });
});

it.runIf(native?.mkdirChildBeneath && !process.versions.bun)("pins nested mkdir resources at each depth", () => {
  for (const depth of [1, 8, 32]) {
    expect(() => execFileSync(process.execPath, ["scripts/native-call-budget-proof.mjs", "--operation", "mkdirNested", "--depth", String(depth),
      "--resources-only"], {
      cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", stdio: "pipe",
    })).not.toThrow();
  }
});
