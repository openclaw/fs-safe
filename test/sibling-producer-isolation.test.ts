import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { writeExternalFileWithinRoot } from "../src/output.js";
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

it.each(["temp", "output"] as const)(
  "%s snapshots producer isolation before its first awaited directory operation",
  async (api) => {
    const root = await tempRoot("fs-safe-isolation-snapshot-");
    const dir = path.join(root, "output");
    const final = path.join(dir, "final.bin");
    const realMkdir = fs.mkdir.bind(fs);
    let reachedGate!: () => void;
    let releaseGate!: () => void;
    const atGate = new Promise<void>((resolve) => { reachedGate = resolve; });
    const released = new Promise<void>((resolve) => { releaseGate = resolve; });
    let gated = false;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const result = await realMkdir(...args);
      if (!gated && path.resolve(String(args[0])) === dir) {
        gated = true;
        reachedGate();
        await released;
      }
      return result;
    });

    let producerIsolation: "private-directory" | undefined = "private-directory";
    let isolationReads = 0;
    let produced = "";
    const write = async (candidate: string) => {
      produced = candidate;
      await fs.writeFile(candidate, "isolated");
    };
    const pending = api === "temp"
      ? writeSiblingTempFile({
          dir,
          writeTemp: write,
          resolveFinalPath: () => final,
          get producerIsolation() {
            isolationReads++;
            return producerIsolation;
          },
        })
      : writeExternalFileWithinRoot({
          rootDir: root,
          path: "output/final.bin",
          staging: "sibling",
          write,
          get producerIsolation() {
            isolationReads++;
            return producerIsolation;
          },
        });

    await atGate;
    producerIsolation = undefined;
    releaseGate();
    await expect(pending).resolves.toMatchObject(api === "temp"
      ? { filePath: final }
      : { path: final });
    expect(isolationReads).toBe(1);
    expect(path.dirname(produced)).not.toBe(dir);
    expect(path.dirname(path.dirname(produced))).toBe(dir);
    await expect(fs.readFile(final, "utf8")).resolves.toBe("isolated");
  },
);

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
