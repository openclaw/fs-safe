import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchive } from "../src/archive.js";
import * as batches from "../src/archive-batch.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { RootHandle } from "../src/root-impl.js";
import { modeArchive, type ModeEntry } from "./helpers/archive-modes.js";
import { observeArchiveFs } from "./helpers/archive-fs-counts.js";
import { paxNative } from "./helpers/archive-pax-native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  __resetNativeLoaderForTest();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
function sequentialBatches() {
  return vi.spyOn(batches, "createArchiveBatch").mockImplementation(() => ({
    add: async (run) => { await run(); }, drain: async () => {},
  }));
}
async function tree(directory: string): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    result.push({ name, mode: process.platform === "win32" ? 0 : stat.mode & 0o777,
      content: stat.isDirectory() ? await tree(file) : await fs.readFile(file, "utf8") });
  }
  return result;
}
async function fixture(kind: "tar" | "zip", entries?: ModeEntry[]) {
  const base = await tempRoot("fs-safe-concurrency-");
  const archivePath = path.join(base, `input.${kind}`);
  await fs.writeFile(archivePath, await modeArchive(kind, entries ?? [
    { path: "d/", directory: true, mode: 0o755 },
    ...Array.from({ length: 10 }, (_, i) => ({ path: `d/f${i.toString().padStart(2, "0")}`, mode: 0o644 })),
    { path: "zz-later/", directory: true, mode: 0o755 },
    { path: "zz-later/file", mode: 0o644 },
  ]));
  const destination = async (name: string) => {
    const destDir = path.join(base, name);
    await fs.mkdir(destDir);
    return { archivePath, destDir, kind, timeoutMs: 30000 };
  };
  return { base, destination };
}

for (const backend of ["auto", "off"] as const) {
  describe.skipIf(backend === "auto" && !paxNative)(`archive concurrency: native ${backend}`, () => {
    for (const kind of ["tar", "zip"] as const) {
      const useBackend = () => {
        if (paxNative) __setNativeLoaderForTest(() => paxNative);
        configureFsSafeNative({ mode: backend });
      };
      it.each(["clamp", "preserve"] as const)(`${kind}: matches sequential contents, modes and fs-call budget (%s)`, async (entryModes) => {
        useBackend();
        const entries = ["a", "a/b", "a/b/c"].flatMap((dir, level) => [
          { path: `${dir}/`, directory: true, mode: 0o750 },
          ...Array.from({ length: 10 }, (_, i) => ({ path: `${dir}/f${i}`, mode: i % 2 ? 0o640 : 0o751 })),
          { path: `${dir}/empty-${level}/`, directory: true, mode: 0o700 },
        ]);
        const { base, destination } = await fixture(kind, entries);
        const serial = await destination("serial");
        const concurrent = await destination("concurrent");
        sequentialBatches();
        const baseline = await observeArchiveFs(base);
        await extractArchive({ ...serial, entryModes });
        const baselineCalls = baseline.total();
        vi.restoreAllMocks();
        const observed = await observeArchiveFs(base);
        await extractArchive({ ...concurrent, entryModes });
        const calls = observed.total();
        vi.restoreAllMocks();
        expect(await tree(concurrent.destDir)).toEqual(await tree(serial.destDir));
        expect(calls, JSON.stringify({ backend, kind, baselineCalls, calls })).toBeLessThanOrEqual(baselineCalls * 1.05);
      });

      it.each([["f00", false], ["f07", false], ["f07", true]] as const)(
        `${kind}: joins a failed batch and preserves its first error (file %s, crosses deadline %s)`, async (failingFile, crossesDeadline) => {
        useBackend();
        const { destination } = await fixture(kind);
        const entered = deferred();
        const release = deferred();
        const failed = deferred();
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => { unhandled.push(error); };
        process.on("unhandledRejection", onUnhandled);
        const copyIn = RootHandle.prototype.copyIn;
        let active = 0;
        let started = 0;
        let startedAfterFailure = 0;
        let settled = false;
        let firstError: unknown;
        const laterFailure = failingFile === "f07" ? "f00" : "f01";
        vi.spyOn(RootHandle.prototype, "copyIn").mockImplementation(async function (relativePath, sourcePath, options) {
          if (firstError) startedAfterFailure++;
          started++;
          if (++active === 8) entered.resolve();
          try {
            if (relativePath === `d/${failingFile}`) {
              await entered.promise;
              await fs.rename(sourcePath, `${sourcePath}.saved`);
              await fs.mkdir(sourcePath);
              try { await copyIn.call(this, relativePath, sourcePath, options); }
              catch (error) { firstError = error; failed.resolve(); throw error; }
            } else {
              await release.promise;
              if (relativePath === `d/${laterFailure}`) throw new Error("later sibling failure");
              await copyIn.call(this, relativePath, sourcePath, options);
            }
          } finally { active--; }
        });
        const parallel = await destination("parallel-failure");
        const extraction = extractArchive({ ...parallel, timeoutMs: crossesDeadline ? 1000 : parallel.timeoutMs });
        void extraction.then(() => { settled = true; }, () => { settled = true; });
        try {
          await failed.promise;
          if (crossesDeadline) await new Promise((resolve) => setTimeout(resolve, 1100));
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(settled).toBe(false);
          expect(active).toBeGreaterThan(0);
          release.resolve();
          await expect(extraction).rejects.toBe(firstError);
          expect(firstError).toMatchObject({ code: "not-file" });
          expect(active).toBe(0);
          expect(started).toBe(8);
          expect(startedAfterFailure).toBe(0);
          const published = (await fs.readdir(path.join(parallel.destDir, "d"))).sort();
          expect(published).toEqual(Array.from({ length: 8 }, (_, i) => `f0${i}`)
            .filter((name) => name !== failingFile && name !== laterFailure));
          expect(published.length).toBeLessThanOrEqual(Number(failingFile.slice(1)) + 8);
          for (const name of published) {
            expect(await fs.readFile(path.join(parallel.destDir, "d", name), "utf8")).toBe("NEW");
          }
          await expect(fs.lstat(path.join(parallel.destDir, "zz-later"))).rejects.toMatchObject({ code: "ENOENT" });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(unhandled).toEqual([]);
        } finally {
          release.resolve();
          await extraction.catch(() => undefined);
          process.off("unhandledRejection", onUnhandled);
        }
      });

      it(`${kind}: joins all eight publications on deadline expiry and starts no next batch`, async () => {
        useBackend();
        const { destination } = await fixture(kind);
        const entered = deferred();
        const release = deferred();
        const copyIn = RootHandle.prototype.copyIn;
        let active = 0;
        let started = 0;
        let settled = false;
        vi.spyOn(RootHandle.prototype, "copyIn").mockImplementation(async function (...args) {
          started++;
          if (++active === 8) entered.resolve();
          try { await release.promise; await copyIn.apply(this, args); }
          finally { active--; }
        });
        const options = await destination("timeout");
        const extraction = extractArchive({ ...options, timeoutMs: 1000 });
        void extraction.then(() => { settled = true; }, () => { settled = true; });
        try {
          await entered.promise;
          await new Promise((resolve) => setTimeout(resolve, 1100));
          expect(active).toBe(8);
          expect(settled).toBe(false);
        } finally { release.resolve(); }
        await expect(extraction).rejects.toThrow(`extract ${kind} timed out after 1000ms`);
        expect(active).toBe(0);
        expect(started).toBe(8);
        const published = await tree(options.destDir);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await tree(options.destDir)).toEqual(published);
      }, 10000);
    }
  });
}
