import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { writeExternalFileViaSibling } from "../src/output-sibling.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __cleanupRegisteredTempPathsForTest();
});

for (const api of ["temp", "output"] as const) {
  describe(`${api} sibling admission and publication (native off)`, () => {
    async function fixture() {
      const dir = await tempRoot("fs-safe-sibling-publication-");
      const outsideDir = await tempRoot("fs-safe-sibling-outside-");
      const outside = path.join(outsideDir, "outside");
      const final = path.join(dir, "final");
      const moved = path.join(dir, "moved");
      await fs.writeFile(outside, "outside", { mode: 0o644 });
      await fs.writeFile(final, "old");
      let temporary = "";
      const run = (write: (candidate: string) => Promise<unknown>) => {
        const produce = async (candidate: string) => {
          temporary = candidate;
          return await write(candidate);
        };
        return api === "temp"
          ? writeSiblingTempFile({ dir, chmodDir: false, mode: 0o600,
              writeTemp: produce, resolveFinalPath: () => final })
          : writeExternalFileViaSibling({ finalPath: final, mode: 0o600, write: produce });
      };
      return { dir, outside, final, moved, run, temp: () => temporary };
    }

    for (const kind of ["directory", "hardlink", "symlink", "fifo"] as const) {
      const test = kind === "fifo" || kind === "symlink" ? itPosix : it;
      test(`rejects callback ${kind} substitution without touching the replacement`, async () => {
        const f = await fixture();
        const before = await fs.lstat(f.outside, { bigint: true });
        let replacement: fsSync.BigIntStats;
        const realRename = fs.rename.bind(fs);
        const rename = vi.spyOn(fs, "rename");
        const chmod = vi.spyOn(fs, "chmod");
        const code = kind === "symlink" ? "symlink" : kind === "hardlink" ? "hardlink" : "not-file";
        await expect(f.run(async (candidate) => {
          await fs.writeFile(candidate, "producer");
          await realRename(candidate, f.moved);
          if (kind === "directory") {
            await fs.mkdir(candidate);
            await fs.writeFile(path.join(candidate, "sentinel"), "keep");
          } else if (kind === "hardlink") await fs.link(f.outside, candidate);
          else if (kind === "symlink") await fs.symlink(f.outside, candidate);
          else await promisify(execFile)("mkfifo", [candidate]);
          replacement = await fs.lstat(candidate, { bigint: true });
        })).rejects.toMatchObject({ code });
        __cleanupRegisteredTempPathsForTest();
        expect(await fs.lstat(f.temp(), { bigint: true })).toMatchObject({
          dev: replacement!.dev, ino: replacement!.ino, mode: replacement!.mode,
        });
        expect(await fs.readFile(f.outside, "utf8")).toBe("outside");
        expect((await fs.lstat(f.outside, { bigint: true })).mode).toBe(before.mode);
        expect(await fs.readFile(f.final, "utf8")).toBe("old");
        if (kind === "directory") expect(await fs.readFile(path.join(f.temp(), "sentinel"), "utf8")).toBe("keep");
        expect(rename).not.toHaveBeenCalled();
        expect(chmod).not.toHaveBeenCalled();
      });
    }

    it.each(["before-open", "after-open"] as const)(
      "rejects a same-name regular replacement %s before mode or publication", async (timing) => {
        const f = await fixture();
        const open = fs.open.bind(fs);
        let retained = -1;
        vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
          if (candidate !== f.temp()) return await open(candidate, flags, mode);
          const replace = async () => {
            await fs.rename(f.temp(), f.moved);
            await fs.writeFile(f.temp(), "replacement", { mode: 0o644 });
          };
          if (timing === "before-open") await replace();
          const handle = await open(candidate, flags, mode);
          retained = handle.fd;
          if (timing === "after-open") await replace();
          return handle;
        });
        await expect(f.run(async (candidate) => fs.writeFile(candidate, "producer")))
          .rejects.toMatchObject({ code: "path-mismatch" });
        __cleanupRegisteredTempPathsForTest();
        expect(await fs.readFile(f.temp(), "utf8")).toBe("replacement");
        if (process.platform !== "win32") expect((await fs.stat(f.temp())).mode & 0o777).toBe(0o644);
        expect(await fs.readFile(f.final, "utf8")).toBe("old");
        expect(() => fsSync.fstatSync(retained)).toThrow(expect.objectContaining({ code: "EBADF" }));
      },
    );

    itPosix("does not block or adopt a FIFO swapped in between lstat and open", async () => {
      const f = await fixture();
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
        if (candidate === f.temp()) {
          expect(Number(flags) & fsSync.constants.O_NONBLOCK).not.toBe(0);
          expect(Number(flags) & fsSync.constants.O_NOFOLLOW).not.toBe(0);
          await fs.rename(f.temp(), f.moved);
          await promisify(execFile)("mkfifo", [f.temp()]);
        }
        return await open(candidate, flags, mode);
      });
      await expect(f.run(async (candidate) => fs.writeFile(candidate, "producer")))
        .rejects.toMatchObject({ code: "not-file" });
      expect((await fs.lstat(f.temp())).isFIFO()).toBe(true);
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
    });

    itPosix("rejects a symlink swapped in at open without touching its referent", async () => {
      const f = await fixture();
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
        if (candidate === f.temp()) {
          await fs.rename(f.temp(), f.moved);
          await fs.symlink(f.outside, f.temp());
        }
        return await open(candidate, flags, mode);
      });
      await expect(f.run(async (candidate) => fs.writeFile(candidate, "producer")))
        .rejects.toMatchObject({ code: "symlink" });
      expect((await fs.lstat(f.temp())).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(f.outside, "utf8")).toBe("outside");
      expect((await fs.stat(f.outside)).mode & 0o777).toBe(0o644);
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
    });

    it.each(["sync", "rename"] as const)("rejects a hardlink added during %s and preserves both names", async (phase) => {
      const f = await fixture();
      const alias = path.join(path.dirname(f.outside), "alias");
      const open = fs.open.bind(fs);
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (args[0] === f.temp() && phase === "sync") {
          vi.spyOn(handle, "sync").mockImplementation(async () => { await fs.link(f.temp(), alias); });
        }
        return handle;
      });
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (from === f.temp() && phase === "rename") await fs.link(f.final, alias);
      });
      await expect(f.run(async (candidate) => fs.writeFile(candidate, "producer")))
        .rejects.toMatchObject({ code: "hardlink" });
      __cleanupRegisteredTempPathsForTest();
      const stage = phase === "sync" ? f.temp() : f.final;
      expect(await fs.readFile(stage, "utf8")).toBe("producer");
      expect(await fs.readFile(alias, "utf8")).toBe("producer");
      expect((await fs.stat(alias)).nlink).toBe(2);
    });

    it("rejects a replacement made during fsync and preserves it during cleanup", async () => {
      const f = await fixture();
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
        const handle = await open(candidate, flags, mode);
        if (candidate === f.temp()) {
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            await fs.rename(f.temp(), f.moved);
            await fs.writeFile(f.temp(), "replacement", { mode: 0o644 });
          });
        }
        return handle;
      });
      await expect(f.run(async (candidate) => fs.writeFile(candidate, "producer")))
        .rejects.toMatchObject({ code: "path-mismatch" });
      __cleanupRegisteredTempPathsForTest();
      expect(await fs.readFile(f.temp(), "utf8")).toBe("replacement");
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
      if (process.platform !== "win32") expect((await fs.stat(f.temp())).mode & 0o777).toBe(0o644);
    });

    it("preserves a replacement installed by a failing rename", async () => {
      const f = await fixture();
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (from !== f.temp()) return await rename(from, to);
        await rename(from, f.moved);
        await fs.writeFile(f.temp(), "replacement");
        throw Object.assign(new Error("rename failed"), { code: "EACCES" });
      });
      await expect(f.run(async (candidate) => fs.writeFile(candidate, "producer")))
        .rejects.toMatchObject({ code: "EACCES" });
      __cleanupRegisteredTempPathsForTest();
      expect(await fs.readFile(f.temp(), "utf8")).toBe("replacement");
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
    });

    it("verifies the published identity and never cleans a final or recreated temp", async () => {
      const f = await fixture();
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        await rename(from, to);
        if (from === f.temp()) {
          await rename(f.final, f.moved);
          await fs.writeFile(f.final, "published replacement", { mode: 0o644 });
          await fs.writeFile(f.temp(), "new temp occupant", { mode: 0o644 });
        }
      });
      await expect(f.run(async (candidate) => fs.writeFile(candidate, "producer")))
        .rejects.toMatchObject({ code: "path-mismatch" });
      __cleanupRegisteredTempPathsForTest();
      expect(await fs.readFile(f.temp(), "utf8")).toBe("new temp occupant");
      expect(await fs.readFile(f.final, "utf8")).toBe("published replacement");
      if (process.platform !== "win32") expect((await fs.stat(f.final)).mode & 0o777).toBe(0o644);
    });

    it("preserves an unadmitted path when the callback throws", async () => {
      const f = await fixture();
      await expect(f.run(async (candidate) => {
        await fs.mkdir(candidate);
        await fs.writeFile(path.join(candidate, "sentinel"), "keep");
        throw new Error("producer failed");
      })).rejects.toThrow("producer failed");
      __cleanupRegisteredTempPathsForTest();
      expect(await fs.readFile(path.join(f.temp(), "sentinel"), "utf8")).toBe("keep");
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
    });
  });
}
