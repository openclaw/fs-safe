import { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const originalIno = 9007199254740992n;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
});

describe("root read exact identity", () => {
  it.each(["reject", "follow-within-root"] as const)(
    "rejects a parent swap whose inode numbers round equally (%s)",
    async (symlinks) => {
      const directory = await tempRoot("fs-safe-root-read-exact-");
      const scoped = await root(directory);
      const parent = path.join(scoped.rootReal, "parent");
      const displaced = path.join(scoped.rootReal, "displaced");
      const replacement = path.join(scoped.rootReal, "replacement");
      const filePath = path.join(parent, "value");
      await fs.mkdir(parent);
      await fs.mkdir(replacement);
      await fs.writeFile(filePath, "original");
      await fs.writeFile(path.join(replacement, "value"), "replacement");
      let swapped = false;
      let close: ReturnType<typeof vi.spyOn> | undefined;
      let read: ReturnType<typeof vi.spyOn> | undefined;
      for (const operation of ["lstat", "stat"] as const) {
        const actual = fs[operation].bind(fs);
        vi.spyOn(fs, operation).mockImplementation(async (...args) => {
          const stat = await actual(...args);
          if (String(args[0]) === filePath) {
            const ino = originalIno + (swapped ? 1n : 0n);
            stat.ino = args[1]?.bigint ? ino : Number(ino);
          }
          return stat;
        });
      }
      __setFsSafeTestHooksForTest({
        async afterPreOpenLstat(candidate) {
          if (candidate !== filePath || swapped) return;
          await fs.rename(parent, displaced);
          await fs.rename(replacement, parent);
          swapped = true;
        },
        afterOpen(candidate, handle) {
          if (candidate !== filePath) return;
          close = vi.spyOn(handle, "close");
          read = vi.spyOn(handle, "read");
          const actual = handle.stat.bind(handle);
          vi.spyOn(handle, "stat").mockImplementation(async (options) => {
            const stat = await actual(options);
            stat.ino = options?.bigint ? originalIno + 1n : Number(originalIno + 1n);
            return stat;
          });
        },
      });

      expect(Number(originalIno)).toBe(Number(originalIno + 1n));
      await expect(scoped.readText("parent/value", { symlinks })).rejects.toMatchObject({ code: "path-mismatch" });
      expect(swapped).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(displaced, "value"), "utf8")).resolves.toBe("original");
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("replacement");
    },
  );

  it.each(["preview", "descriptor", "pathname", "realpath"] as const)(
    "rejects persistent unknown %s identity without reading",
    async (boundary) => {
      const directory = await tempRoot("fs-safe-root-read-unknown-");
      const scoped = await root(directory);
      const filePath = path.join(scoped.rootReal, "value");
      await fs.writeFile(filePath, "original");
      let opened = false;
      let close: ReturnType<typeof vi.spyOn> | undefined;
      let read: ReturnType<typeof vi.spyOn> | undefined;
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (String(args[0]) === filePath && args[1]?.bigint &&
          ((boundary === "preview" && !opened) || (boundary === "pathname" && opened))) {
          stat.ino = 0n;
        }
        return stat;
      });
      const stat = fs.stat.bind(fs);
      vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        const result = await stat(...args);
        if (String(args[0]) === filePath && args[1]?.bigint && boundary === "realpath") {
          result.ino = 0n;
        }
        return result;
      });
      __setFsSafeTestHooksForTest({
        afterOpen(candidate, handle) {
          if (candidate !== filePath) return;
          opened = true;
          close = vi.spyOn(handle, "close");
          read = vi.spyOn(handle, "read");
          const actual = handle.stat.bind(handle);
          vi.spyOn(handle, "stat").mockImplementation(async (options) => {
            const result = await actual(options);
            if (options?.bigint && boundary === "descriptor") result.ino = 0n;
            return result;
          });
        },
      });

      await expect(scoped.readText("value")).rejects.toMatchObject({ code: "path-mismatch" });
      if (boundary === "preview" && process.platform === "win32") {
        expect(opened).toBe(false);
      } else {
        expect(close).toHaveBeenCalledTimes(1);
        expect(read).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps the public receipt numeric", async () => {
    const directory = await tempRoot("fs-safe-root-read-receipt-");
    await fs.writeFile(path.join(directory, "value"), "original");
    const scoped = await root(directory);
    const result = await scoped.read("value");
    expect(result.stat).toBeInstanceOf(Stats);
    expect(typeof result.stat.ino).toBe("number");
    expect(result.buffer.toString()).toBe("original");
  });

  it.each([false, true])("handles a Windows preview retry (lookup fails: %s)", async (fails) => {
    const directory = await tempRoot("fs-safe-root-preview-retry-");
    const scoped = await root(directory);
    const filePath = path.join(scoped.rootReal, "value");
    await fs.writeFile(filePath, "original");
    Object.defineProperty(process, "platform", { value: "win32" });
    let inspections = 0;
    const beforeOpen = vi.fn();
    __setFsSafeTestHooksForTest({ beforeOpen });
    const failure = Object.assign(new Error("re-inspection denied"), { code: "EACCES" });
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      if (String(args[0]) === filePath && args[1]?.bigint && beforeOpen.mock.calls.length === 0) {
        inspections++;
        if (inspections === 1) stat.ino = 0n;
        else if (fails) throw failure;
      }
      return stat;
    });
    const pending = scoped.readText("value");
    if (fails) {
      await expect(pending).rejects.toBe(failure);
      expect(beforeOpen).not.toHaveBeenCalled();
    } else {
      await expect(pending).resolves.toBe("original");
      expect(beforeOpen).toHaveBeenCalledTimes(1);
    }
    expect(inspections).toBe(2);
  });
});
