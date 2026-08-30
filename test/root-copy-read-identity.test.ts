import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const ino = 9007199254740992n;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  __setFsSafeTestHooksForTest(undefined);
  __resetFsSafeNativeConfigForTest();
});

describe("Root copy source lifetime", () => {
  it.each(["before-copy", "after-copy", "unknown-after-copy"] as const)("rejects source identity drift %s", async (timing) => {
    const directory = await fs.realpath(await tempRoot("fs-safe-copy-identity-"));
    const source = path.join(directory, "source");
    const displaced = path.join(directory, "displaced");
    const replacement = path.join(directory, "replacement");
    await fs.writeFile(source, "original");
    await fs.writeFile(replacement, "replacement");
    const scoped = await root(directory);
    let swapped = false;
    const read = vi.fn();
    let close: ReturnType<typeof vi.spyOn> | undefined;
    const swap = () => {
      if (swapped) return;
      fsSync.renameSync(source, displaced);
      fsSync.renameSync(replacement, source);
      swapped = true;
    };
    for (const method of ["lstat", "stat"] as const) {
      const actual = fs[method].bind(fs);
      vi.spyOn(fs, method).mockImplementation(async (...args) => {
        const stat = await actual(...args);
        if (String(args[0]) === source) {
          const value = swapped ? (timing === "unknown-after-copy" ? 0n : ino + 1n) : ino;
          stat.ino = args[1]?.bigint ? value : Number(value);
        }
        return stat;
      });
    }
    __setFsSafeTestHooksForTest({
      afterOpen(candidate, handle) {
        if (candidate !== source) return;
        close = vi.spyOn(handle, "close");
        const actualStat = handle.stat.bind(handle);
        let inspections = 0;
        vi.spyOn(handle, "stat").mockImplementation(async (options) => {
          if (++inspections === 3 && timing === "before-copy") swap();
          const stat = await actualStat(options);
          stat.ino = options?.bigint ? ino : Number(ino);
          return stat;
        });
        const stream = handle.createReadStream.bind(handle);
        vi.spyOn(handle, "createReadStream").mockImplementation((options) => {
          read();
          if (timing !== "before-copy") swap();
          return stream(options);
        });
      },
    });
    if (timing === "unknown-after-copy") Object.defineProperty(process, "platform", { value: "win32" });
    await expect(scoped.copyIn("target", source)).rejects.toMatchObject({ code: "path-mismatch" });
    expect(swapped).toBe(true);
    expect(read).toHaveBeenCalledTimes(timing === "before-copy" ? 0 : 1);
    expect(close).toHaveBeenCalled();
    expect(await fs.readFile(source, "utf8")).toBe("replacement");
    expect(await fs.readFile(displaced, "utf8")).toBe("original");
    await expect(fs.access(path.join(directory, "target"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
