import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __loadBundledNativeForTest,
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { writeExternalFileWithinRoot } from "../src/output.js";
import { writeSiblingTempFile } from "../src/sibling-temp.js";
import { __cleanupRegisteredTempPathsForTest } from "../src/temp-cleanup.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
try {
  native = __loadBundledNativeForTest();
} catch {
  // JavaScript-only jobs intentionally exercise only the hard-link handoff.
}
const handoffBackends = native ? (["fallback", "native"] as const) : (["fallback"] as const);
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __cleanupRegisteredTempPathsForTest();
});

for (const api of ["temp", "output"] as const) {
  describe(`${api} isolated sibling producer`, () => {
    async function fixture() {
      const root = await tempRoot("fs-safe-isolated-producer-");
      const dir = path.join(root, "output");
      await fs.mkdir(dir, { mode: 0o755 });
      const final = path.join(dir, "final.bin");
      await fs.writeFile(final, "old");
      const run = <T>(write: (candidate: string) => Promise<T>, mode?: number) => {
        const isolation = { producerIsolation: "private-directory" as const };
        return api === "temp"
          ? writeSiblingTempFile({
              dir, chmodDir: false, writeTemp: write, resolveFinalPath: () => final,
              syncTempFile: true, syncParentDir: true, mode, ...isolation,
            })
          : writeExternalFileWithinRoot({
              rootDir: dir, path: "final.bin", staging: "sibling", write, mode, ...isolation,
            });
      };
      return { root, dir, final, run };
    }

    it("cleans partial output when the producer throws while preserving the destination", async () => {
      const f = await fixture();
      const failure = new Error("producer failed after writing");
      let produced = "";
      await expect(f.run(async (candidate) => {
        produced = candidate;
        await fs.writeFile(candidate, "partial");
        throw failure;
      })).rejects.toBe(failure);
      expect(await fs.readdir(f.dir)).toEqual(["final.bin"]);
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
      expect(path.dirname(produced)).not.toBe(f.dir);
      await expect(fs.lstat(path.dirname(produced))).rejects.toMatchObject({ code: "ENOENT" });
    });

    if (api === "temp") {
      it("rechecks the admitted parent before creation without recapturing the producer root", async () => {
        const f = await fixture();
        const parentReal = fsSync.realpathSync.native(f.dir);
        const originalLstat = fsSync.lstatSync;
        const originalRealpath = fsSync.realpathSync.native;
        const originalStat = fsSync.statSync;
        const originalMkdtemp = fs.mkdtemp.bind(fs);
        const samePath = (left: string, right: string) => process.platform === "win32"
          ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
          : path.normalize(left) === path.normalize(right);
        let parentLstats = 0;
        let parentRealpaths = 0;
        let parentStats = 0;
        let callsAtMkdtemp: { lstat: number; realpath: number; stat: number } | undefined;
        vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
          if (!callsAtMkdtemp && samePath(String(args[0]), f.dir)) parentLstats++;
          return originalLstat(...args);
        });
        vi.spyOn(fsSync.realpathSync, "native").mockImplementation((...args) => {
          if (!callsAtMkdtemp && samePath(String(args[0]), f.dir)) parentRealpaths++;
          return originalRealpath(...args);
        });
        vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
          if (!callsAtMkdtemp && samePath(String(args[0]), parentReal)) parentStats++;
          return originalStat(...args);
        });
        vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
          callsAtMkdtemp ??= {
            lstat: parentLstats,
            realpath: parentRealpaths,
            stat: parentStats,
          };
          return await originalMkdtemp(...args);
        });

        await expect(f.run(async (candidate) => {
          await fs.writeFile(candidate, "isolated");
        })).resolves.toMatchObject({ filePath: f.final });

        // Capture once, then recheck after the awaited capture before creation.
        expect(callsAtMkdtemp).toEqual({ lstat: 2, realpath: 2, stat: 0 });
        await expect(fs.readFile(f.final, "utf8")).resolves.toBe("isolated");
      });
    }

    it("rejects a replaced creation receipt before invoking the producer", async () => {
      const f = await fixture();
      const lstat = fsSync.lstatSync;
      let replacement = "";
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        const observed = String(args[0]);
        if (!replacement && stat.isDirectory() && path.dirname(observed) === f.dir) {
          replacement = observed;
          fsSync.renameSync(observed, path.join(f.root, "original-workspace"));
          fsSync.mkdirSync(observed);
          fsSync.writeFileSync(path.join(observed, "sentinel"), "replacement must remain");
        }
        return stat;
      });
      const producer = vi.fn(async (candidate: string) => fs.writeFile(candidate, "must not run"));
      await expect(f.run(producer)).rejects.toMatchObject({ code: "path-mismatch" });
      expect(producer).not.toHaveBeenCalled();
      expect(replacement).not.toBe("");
      expect(await fs.readFile(path.join(replacement, "sentinel"), "utf8")).toBe("replacement must remain");
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
    });

    it.each(["parent", "workspace"] as const)("preserves replacements when the %s directory changes", async (scope) => {
      const f = await fixture();
      const displaced = path.join(f.root, "displaced");
      let replacement = "";
      let retained = "";
      await expect(f.run(async (candidate) => {
        await fs.writeFile(candidate, "owned output");
        const directory = scope === "parent" ? f.dir : path.dirname(candidate);
        const relative = path.relative(directory, candidate);
        retained = path.join(displaced, relative);
        replacement = path.join(directory, relative);
        await fs.rename(directory, displaced);
        await fs.mkdir(path.dirname(replacement), { recursive: true });
        await fs.writeFile(replacement, "replacement must remain");
      })).rejects.toMatchObject({ code: "path-mismatch" });
      __cleanupRegisteredTempPathsForTest();
      expect(await fs.readFile(replacement, "utf8")).toBe("replacement must remain");
      expect(await fs.readFile(retained, "utf8")).toBe("owned output");
      if (scope === "parent") {
        await expect(fs.lstat(f.final)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(displaced, "final.bin"), "utf8")).toBe("old");
      } else {
        expect(await fs.readFile(f.final, "utf8")).toBe("old");
      }
    });

    it("rechecks workspace identity at the move boundary", async () => {
      const f = await fixture();
      const displaced = path.join(f.root, "displaced");
      const lstat = fsSync.lstatSync;
      let produced = "";
      let replaced = false;
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        if (produced && !replaced && args[0] === f.dir) {
          replaced = true;
          fsSync.renameSync(path.dirname(produced), displaced);
          fsSync.mkdirSync(path.dirname(produced));
          fsSync.writeFileSync(produced, "replacement must remain");
        }
        return stat;
      });
      await expect(f.run(async (candidate) => {
        await fs.writeFile(candidate, "owned output");
        produced = candidate;
      })).rejects.toMatchObject({ code: "path-mismatch" });
      expect(replaced).toBe(true);
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
      expect(await fs.readFile(produced, "utf8")).toBe("replacement must remain");
      expect(await fs.readFile(path.join(displaced, path.basename(produced)), "utf8")).toBe("owned output");
    });

    itPosix.each(["symlink", "hardlink"] as const)("rejects a producer %s without modifying its referent", async (kind) => {
      const f = await fixture();
      const outside = path.join(f.root, "outside");
      await fs.writeFile(outside, "outside", { mode: 0o640 });
      const before = await fs.stat(outside);
      await expect(f.run(async (candidate) => {
        if (kind === "symlink") await fs.symlink(outside, candidate);
        else await fs.link(outside, candidate);
      }, 0o600)).rejects.toMatchObject({ code: kind === "symlink" ? "path-alias" : "hardlink" });
      expect(await fs.readFile(outside, "utf8")).toBe("outside");
      expect((await fs.stat(outside)).mode).toBe(before.mode);
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
      expect(await fs.readdir(f.dir)).toEqual(["final.bin"]);
    });

    it("publishes native-off output without copying or changing its identity", async () => {
      const f = await fixture();
      let producedIdentity: fsSync.BigIntStats | undefined;
      const published = await f.run(async (candidate) => {
        await fs.writeFile(candidate, "producer");
        producedIdentity = await fs.lstat(candidate, { bigint: true });
        return "result";
      });
      const finalIdentity = await fs.lstat(f.final, { bigint: true });
      expect(published.result).toBe("result");
      expect(finalIdentity.dev).toBe(producedIdentity!.dev);
      expect(finalIdentity.ino).toBe(producedIdentity!.ino);
      expect(finalIdentity.nlink).toBe(1n);
      expect(await fs.readFile(f.final, "utf8")).toBe("producer");
      expect(await fs.readdir(f.dir)).toEqual(["final.bin"]);
    });

    it("retries transient unknown Windows identities throughout isolated admission", async () => {
      const f = await fixture();
      const lstat = fsSync.lstatSync.bind(fsSync);
      const fstat = fsSync.fstatSync.bind(fsSync);
      let sourcePath = "";
      let lstatFileInspections = 0;
      let fstatFileInspections = 0;
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        const candidate = String(args[0]);
        if (
          args[1]?.bigint &&
          stat.isFile() &&
          sourcePath &&
          (candidate === sourcePath || (path.dirname(candidate) === f.dir && candidate !== f.final))
        ) {
          lstatFileInspections++;
          if (lstatFileInspections % 2 === 1) Object.assign(stat, { dev: 0n, ino: 0n });
        }
        return stat;
      });
      vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
        const stat = fstat(...args);
        if (args[1]?.bigint && stat.isFile() && sourcePath) {
          fstatFileInspections++;
          if (fstatFileInspections % 2 === 1) Object.assign(stat, { dev: 0n, ino: 0n });
        }
        return stat;
      });

      const published = await f.run(async (candidate) => {
        sourcePath = candidate;
        await fs.writeFile(candidate, "producer");
        return "result";
      });
      expect(published.result).toBe("result");
      expect(lstatFileInspections).toBeGreaterThanOrEqual(8);
      expect(fstatFileInspections).toBeGreaterThanOrEqual(6);
      expect(await fs.readFile(f.final, "utf8")).toBe("producer");
      expect(await fs.readdir(f.dir)).toEqual(["final.bin"]);
    });

    it("fails closed after two persistent unknown Windows source identities", async () => {
      const f = await fixture();
      const lstat = fsSync.lstatSync.bind(fsSync);
      let sourcePath = "";
      let sourceInspections = 0;
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        if (args[1]?.bigint && sourcePath && String(args[0]) === sourcePath) {
          sourceInspections++;
          Object.assign(stat, { dev: 0n, ino: 0n });
        }
        return stat;
      });

      await expect(f.run(async (candidate) => {
        sourcePath = candidate;
        await fs.writeFile(candidate, "producer");
      })).rejects.toMatchObject({ code: "path-mismatch" });
      expect(sourceInspections).toBe(2);
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
      expect(await fs.readdir(f.dir)).toEqual(["final.bin"]);
      await expect(fs.lstat(path.dirname(sourcePath))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["EXDEV", "EPERM"])("fails closed when hard-link handoff reports %s", async (code) => {
      const f = await fixture();
      vi.spyOn(fsSync, "linkSync").mockImplementation(() => {
        throw Object.assign(new Error("hard link unavailable"), { code });
      });
      await expect(f.run(async (candidate) => {
        await fs.writeFile(candidate, "producer");
      })).rejects.toMatchObject({ code: "helper-unavailable" });
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
      expect(await fs.readdir(f.dir)).toEqual(["final.bin"]);
    });

    it.each(handoffBackends)("removes the admitted sibling when %s workspace cleanup fails", async (backend) => {
      const f = await fixture();
      if (backend === "native") {
        __setNativeLoaderForTest(() => native!);
        configureFsSafeNative({ mode: "require" });
      }
      const cleanupFailure = new Error(`${backend} workspace cleanup failed`);
      const realRm = fs.rm.bind(fs);
      let workspace = "";
      vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
        if (workspace && path.resolve(String(args[0])) === workspace) throw cleanupFailure;
        await realRm(...args);
      });

      await expect(f.run(async (candidate) => {
        workspace = path.dirname(candidate);
        await fs.writeFile(candidate, "producer");
      })).rejects.toBe(cleanupFailure);
      expect(workspace).not.toBe("");
      expect(await fs.readdir(workspace)).toEqual([]);
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
      expect((await fs.readdir(f.dir)).sort()).toEqual(
        ["final.bin", path.basename(workspace)].sort(),
      );
    });

    it("preserves a competing sibling when hard-link publication collides", async () => {
      const f = await fixture();
      const link = fsSync.linkSync.bind(fsSync);
      let competitor = "";
      vi.spyOn(fsSync, "linkSync").mockImplementation((source, target) => {
        competitor = String(target);
        fsSync.writeFileSync(competitor, "competitor");
        link(source, target);
      });
      try {
        await expect(f.run(async (candidate) => {
          await fs.writeFile(candidate, "producer");
        })).rejects.toMatchObject({ code: "already-exists" });
        expect(await fs.readFile(competitor, "utf8")).toBe("competitor");
        expect(await fs.readFile(f.final, "utf8")).toBe("old");
      } finally {
        if (competitor) await fs.rm(competitor, { force: true });
      }
    });

    it("cleans the owned sibling when source-name removal fails", async () => {
      const f = await fixture();
      const link = fsSync.linkSync.bind(fsSync);
      const unlink = fsSync.unlinkSync.bind(fsSync);
      let sourcePath = "";
      let siblingPath = "";
      let rejected = false;
      vi.spyOn(fsSync, "linkSync").mockImplementation((source, target) => {
        sourcePath = String(source);
        siblingPath = String(target);
        link(source, target);
      });
      vi.spyOn(fsSync, "unlinkSync").mockImplementation((pathname) => {
        if (!rejected && String(pathname) === sourcePath) {
          rejected = true;
          throw Object.assign(new Error("source unlink denied"), { code: "EPERM" });
        }
        unlink(pathname);
      });
      await expect(f.run(async (candidate) => {
        await fs.writeFile(candidate, "producer");
      })).rejects.toMatchObject({ code: "EPERM" });
      expect(rejected).toBe(true);
      await expect(fs.lstat(siblingPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(f.final, "utf8")).toBe("old");
      expect(await fs.readdir(f.dir)).toEqual(["final.bin"]);
    });

    it.each(["parent", "workspace"] as const)("rejects %s identities that collide when converted to numbers", async (scope) => {
      const f = await fixture();
      const lstat = fsSync.lstatSync;
      const readStat = fsSync.statSync;
      const first = 9_007_199_254_740_992n;
      let changed = false;
      let produced = "";
      const substituteIdentity = (pathname: fsSync.PathLike, stat: fsSync.Stats | fsSync.BigIntStats) => {
        const observedPath = String(pathname);
        const target = scope === "parent" ? observedPath === f.dir : path.dirname(observedPath) === f.dir;
        if (stat.isDirectory() && target) {
          const ino = first + (changed ? 1n : 0n);
          stat.ino = typeof stat.ino === "bigint" ? ino : Number(ino);
        }
      };
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        substituteIdentity(args[0], stat);
        return stat;
      });
      vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
        const stat = readStat(...args);
        if (stat) substituteIdentity(args[0], stat);
        return stat;
      });
      await expect(f.run(async (candidate) => {
        produced = candidate;
        await fs.writeFile(candidate, "owned output");
        if (scope === "parent") {
          const displaced = path.join(f.root, "displaced");
          await fs.rename(f.dir, displaced);
          await fs.mkdir(f.dir);
          // Retain the workspace identity so only the changed parent rejects handoff.
          await fs.rename(
            path.join(displaced, path.basename(path.dirname(candidate))),
            path.dirname(candidate),
          );
        }
        changed = true;
      })).rejects.toMatchObject({ code: "path-mismatch" });
      expect(produced).not.toBe("");
      if (scope === "parent") {
        await expect(fs.lstat(f.final)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(f.root, "displaced", "final.bin"), "utf8")).toBe("old");
      } else {
        expect(await fs.readFile(f.final, "utf8")).toBe("old");
        expect(await fs.readFile(produced, "utf8")).toBe("owned output");
      }
    });

    itPosix.each([undefined, 0, 0o600])("publishes with mode %s through the synchronized descriptor", async (mode) => {
      const f = await fixture();
      await fs.chmod(f.dir, 0o755);
      const operations: string[] = [];
      let produced = "";
      let identity: fsSync.BigIntStats;
      const open = fs.open.bind(fs);
      const rename = fs.rename.bind(fs);
      const chmod = vi.spyOn(fs, "chmod").mockRejectedValue(new Error("pathname chmod forbidden"));
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          operations.push(args[0] === f.dir ? "parent-sync" : "file-sync");
          await sync();
        });
        return handle;
      });
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (to === f.final) {
          expect(operations).toContain("file-sync");
          const stage = await fs.lstat(from, { bigint: true });
          expect(stage.ino).toBe(identity.ino);
          expect(stage.dev).toBe(identity.dev);
          expect(Number(stage.mode & 0o777n)).toBe(mode ?? 0o640);
          operations.push("publish");
        }
        await rename(from, to);
      });
      const result = { opaque: "producer result" };
      const published = await f.run(async (candidate) => {
        produced = candidate;
        await expect(fs.lstat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
        const writer = await fs.open(candidate, "wx", 0o600);
        try {
          await writer.writeFile("new");
          await writer.chmod(0o640);
          identity = await writer.stat({ bigint: true });
        } finally {
          await writer.close();
        }
        return result;
      }, mode);
      expect(published.result).toBe(result);
      expect(operations.indexOf("parent-sync")).toBeGreaterThan(operations.indexOf("publish"));
      expect((await fs.stat(f.final)).mode & 0o777).toBe(mode ?? 0o640);
      expect((await fs.stat(f.dir)).mode & 0o777).toBe(0o755);
      expect(path.dirname(path.dirname(produced))).toBe(f.dir);
      expect(chmod).not.toHaveBeenCalled();
      expect(await fs.readdir(f.dir)).toEqual(["final.bin"]);
    });
  });
}
