import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

let native: NativeBinding | undefined;
try { native = __loadBundledNativeForTest(); } catch { /* Native CI supplies the binding. */ }
const { tempRoot } = useRealTempDirs();
afterEach(() => { __resetNativeLoaderForTest(); __resetFsSafeNativeConfigForTest(); });

describe.runIf(native?.mkdirOpenChildBeneath)("native mkdir with missing parents", () => {
  it.skipIf(process.versions.bun)("does not allocate a promise chain for synchronous native metadata", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("mkdir-missing-budget-");
    const safe = await root(directory);
    const context = new AsyncLocalStorage<Record<string, number>>();
    const counts: Record<string, number> = {};
    const hook = createHook({ init(_id, type) {
      if (context.getStore() === counts) counts[type] = (counts[type] ?? 0) + 1;
    } });
    hook.enable();
    try { await context.run(counts, () => safe.mkdir("a/b/c")); }
    finally { hook.disable(); }
    expect(fs.statSync(path.join(directory, "a/b/c")).isDirectory()).toBe(true);
    expect(counts.FSREQPROMISE ?? 0).toBe(0);
    expect(counts.PROMISE ?? 0).toBeLessThanOrEqual(7);
  });

  it("preserves a file raced into a missing component and the typed error", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("mkdir-missing-file-");
    const safe = await root(directory);
    __setNativeLoaderForTest(() => ({ ...native!, mkdirOpenChildBeneath(...args) {
      if (args[1] === "b") fs.writeFileSync(path.join(directory, "a/b"), "raced file");
      return native!.mkdirOpenChildBeneath!(...args);
    } }));
    await expect(safe.mkdir("a/b/c")).rejects.toMatchObject({ code: "not-file" });
    expect(fs.readFileSync(path.join(directory, "a/b"), "utf8")).toBe("raced file");
  });

  it("matches the captured existing ancestor before creating its missing suffix", async () => {
    configureFsSafeNative({ mode: "require" });
    const directory = await tempRoot("mkdir-missing-ancestor-");
    const parent = path.join(directory, "parent");
    fs.mkdirSync(parent);
    const safe = await root(directory);
    let swapped = false;
    __setNativeLoaderForTest(() => ({ ...native!, openBeneath(...args) {
      if (!swapped && args[1] === "parent") {
        swapped = true;
        fs.renameSync(parent, `${parent}-held`);
        fs.mkdirSync(parent);
      }
      return native!.openBeneath!(...args);
    } }));
    await expect(safe.mkdir("parent/a/b/c")).rejects.toMatchObject({ code: "path-mismatch" });
    expect(swapped).toBe(true);
    expect(fs.readdirSync(parent)).toEqual([]);
    expect(fs.readdirSync(`${parent}-held`)).toEqual([]);
  });

  for (const level of ["a", "b", "c"]) {
    it(`rejects a substituted ${level} while retaining all created handles`, async () => {
      configureFsSafeNative({ mode: "require" });
      const directory = await tempRoot("mkdir-missing-swap-");
      const safe = await root(directory);
      const opened: number[] = [];
      const closed: number[] = [];
      let swapped = false;
      __setNativeLoaderForTest(() => ({ ...native!,
        mkdirOpenChildBeneath(...args) {
          const result = native!.mkdirOpenChildBeneath!(...args);
          opened.push(result.fd);
          if (args[1] === level) {
            const target = path.join(directory, ...["a", "b", "c"].slice(0, ["a", "b", "c"].indexOf(level) + 1));
            fs.renameSync(target, `${target}-held`);
            fs.mkdirSync(target);
            swapped = true;
          }
          return result;
        },
        closeOwnedFd(fd) { closed.push(fd); return native!.closeOwnedFd!(fd); },
      }));
      await expect(safe.mkdir("a/b/c")).rejects.toMatchObject({ code: "path-mismatch" });
      expect(swapped).toBe(true);
      expect(closed.sort()).toEqual(opened.sort());
      expect(fs.readdirSync(path.join(directory, ...["a", "b", "c"].slice(0, ["a", "b", "c"].indexOf(level) + 1)))).toEqual([]);
    });
  }

  it("keeps a root replacement from diverting any missing component", async () => {
    configureFsSafeNative({ mode: "require" });
    const container = await tempRoot("mkdir-missing-root-");
    const outside = await tempRoot("mkdir-missing-outside-");
    const directory = path.join(container, "root");
    fs.mkdirSync(directory);
    const safe = await root(directory);
    let swapped = false;
    __setNativeLoaderForTest(() => ({ ...native!, mkdirOpenChildBeneath(...args) {
      if (!swapped) {
        swapped = true;
        fs.renameSync(directory, `${directory}-held`);
        fs.symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir");
      }
      return native!.mkdirOpenChildBeneath!(...args);
    } }));
    await expect(safe.mkdir("a/b/c")).rejects.toMatchObject({ code: expect.stringMatching(/^(path-mismatch|ENOENT)$/) });
    expect(swapped).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(directory);
  });
});
