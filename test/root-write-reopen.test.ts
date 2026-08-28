import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, root } from "../src/index.js";
import * as verification from "../src/root-write-verification.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const verify = verification.verifyAtomicWriteResult;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  configureFsSafeNative({ mode: "auto" });
});

describe("Windows publication reopen guards", () => {
  it.each(["symlink", "hardlink", "late hardlink", "EISDIR"])("rejects %s during reopen without reading", async (attack) => {
    const directory = await tempRoot("fs-safe-write-reopen-");
    const target = path.join(directory, "target");
    const alias = path.join(directory, "alias");
    const scoped = await root(directory);
    configureFsSafeNative({ mode: "off" });
    Object.defineProperty(process, "platform", { value: "win32" });
    let opaque = false;
    let reopened: fs.FileHandle | undefined;
    let close: ReturnType<typeof vi.spyOn> | undefined;
    let read: ReturnType<typeof vi.spyOn> | undefined;
    let readFile: ReturnType<typeof vi.spyOn> | undefined;
    let retainedFd: number | undefined;
    let linked = false;
    for (const operation of ["stat", "lstat"] as const) {
      const actual = fs[operation].bind(fs);
      vi.spyOn(fs, operation).mockImplementation(async (...args) => {
        const stat = await actual(...args);
        if (!opaque || String(args[0]) !== target) return stat;
        if (operation === "stat" && reopened && attack === "late hardlink" && !linked) {
          await fs.link(target, alias);
          linked = true;
        }
        stat.dev = args[1]?.bigint ? 0n : 0;
        stat.ino = args[1]?.bigint ? 0n : 0;
        return stat;
      });
    }
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (!opaque || String(args[0]) !== target) return await open(...args);
      if (attack === "EISDIR") throw Object.assign(new Error("raced directory"), { code: "EISDIR" });
      if (attack === "symlink") {
        await fs.rename(target, alias);
        await fs.symlink(alias, target, "file");
      }
      reopened = await open(...args);
      close = vi.spyOn(reopened, "close");
      read = vi.spyOn(reopened, "read");
      readFile = vi.spyOn(reopened, "readFile");
      if (attack === "hardlink") await fs.link(target, alias);
      return reopened;
    });
    vi.spyOn(verification, "verifyAtomicWriteResult").mockImplementation(async (params) => {
      retainedFd = params.fd;
      opaque = true;
      await verify(params);
    });

    await expect(scoped.create("target", "published")).rejects.toMatchObject({
      code: attack === "EISDIR" ? "not-file" : attack === "symlink" ? "symlink" : "hardlink",
    });
    if (attack === "EISDIR") {
      expect(reopened).toBeUndefined();
    } else {
      expect(close).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
      expect(reopened?.fd).toBe(-1);
    }
    expect(() => fsSync.fstatSync(retainedFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(await fs.readFile(attack === "EISDIR" ? target : alias, "utf8")).toBe("published");
  });
});
