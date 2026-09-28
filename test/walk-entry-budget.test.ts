import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { walkDirectory, walkDirectorySync } from "../src/walk.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());
const modes = ["async", "sync", "filesystem", "entries"] as const;

it.each(modes)("bounds a 200,000-entry directory to eleven reads (%s)", async mode => {
  const directory = await tempRoot("fs-safe-wide-budget-");
  await fs.writeFile(path.join(directory, "sample"), "value");
  const sample = fsSync.readdirSync(directory, { withFileTypes: true })[0]!;
  const stat = fsSync.lstatSync(path.join(directory, "sample"));
  const capability = await root(directory);
  const count = 200_000;
  const name = (index: number) => `file-${String(count - index).padStart(6, "0")}`;
  const entry = (index: number, raw = false) => Object.assign(Object.create(Object.getPrototypeOf(sample)), sample, {
    name: raw ? Buffer.from(name(index)) : name(index),
  });
  let reads = 0;
  let closes = 0;
  let prefetched = 0;
  const open = (_directory: unknown, options: { bufferSize?: number; encoding?: string } = {}) => {
    const standalone = mode === "async" || mode === "sync";
    expect(options.bufferSize).toBe(standalone ? undefined : 1);
    const bufferSize = options.bufferSize ?? 32;
    let buffered: fsSync.Dirent[] = [];
    const read = () => {
      if (!buffered.length && prefetched < count) {
        buffered = Array.from({ length: Math.min(bufferSize, count - prefetched) }, () =>
          entry(prefetched++, options.encoding === "buffer"));
      }
      reads++;
      return buffered.shift() ?? null;
    };
    return { read: async () => read(), readSync: read,
      close: async () => { closes++; }, closeSync: () => { closes++; } } as unknown as fsSync.Dir;
  };
  vi.spyOn(fs, "opendir").mockImplementation(open as never);
  vi.spyOn(fsSync, "opendirSync").mockImplementation(open as never);
  // The previous eager implementation must allocate the entire synthetic directory.
  const eager = () => Array.from({ length: count }, (_, index) => entry(index));
  const asyncRead = vi.spyOn(fs, "readdir").mockImplementation((async (_dir, options) =>
    mode === "async" ? eager() : Array.from({ length: count }, (_, index) =>
      (options as { encoding?: string })?.encoding === "buffer" ? Buffer.from(name(index)) : name(index))) as typeof fs.readdir);
  const syncRead = vi.spyOn(fsSync, "readdirSync").mockImplementation(eager as never);
  const lstat = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((candidate, options) =>
    path.dirname(String(candidate)) === directory ? stat : lstat(candidate, options as never)) as typeof fsSync.lstatSync);
  const before = process.memoryUsage().heapUsed;
  let peak = before;
  const sampleHeap = () => { peak = Math.max(peak, process.memoryUsage().heapUsed); return true; };
  const started = performance.now();
  if (mode === "async" || mode === "sync") {
    const result = await (mode === "async" ? walkDirectory : walkDirectorySync)(directory, {
      maxEntries: 10, include: sampleHeap,
    });
    expect(result.scannedEntryCount).toBe(10);
    expect(result.entries).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.failedDirs).toEqual([]);
  } else if (mode === "entries") {
    await expect(Array.fromAsync(capability.entries("", { order: "sorted", maxEntries: 10 })))
      .rejects.toMatchObject({ code: "too-large" });
  } else {
    const result = await Array.fromAsync(capability.walk("", {
      symlinkPolicy: "skip", order: mode, maxEntries: 10,
      entryFilter: () => { sampleHeap(); return "include"; },
    }));
    expect(result.filter(entry => entry.kind === "file")).toHaveLength(10);
    expect(result.at(-1)?.kind).toBe("truncated");
  }
  sampleHeap();
  const elapsedMs = performance.now() - started;
  const heapDelta = Math.max(0, peak - before);
  console.log(JSON.stringify({ mode, directoryEntries: count, maxEntries: 10, reads, prefetched, heapDelta, elapsedMs }));
  expect(reads).toBe(11);
  expect(prefetched).toBe(mode === "async" || mode === "sync" ? 32 : 11);
  expect(closes).toBe(1);
  expect(asyncRead).not.toHaveBeenCalled();
  expect(syncRead).not.toHaveBeenCalled();
  expect(heapDelta).toBeLessThan(2 * 1024 * 1024);
  expect(elapsedMs).toBeLessThan(2_000);
});

it("bounds real filesystem scans, including an exactly exhausted budget", async () => {
  const directory = await tempRoot("fs-safe-real-budget-");
  for (let index = 0; index < 128; index++) fsSync.writeFileSync(path.join(directory, `file-${index}`), "");
  const capability = await root(directory);
  for (const maxEntries of [0, 10, 128]) {
    for (const walk of [walkDirectory, walkDirectorySync]) {
      const scan = await walk(directory, { maxEntries });
      expect(scan.scannedEntryCount).toBe(maxEntries);
      expect(scan.truncated).toBe(maxEntries < 128);
      expect(scan.failedDirs).toEqual([]);
    }
    const entries = await Array.fromAsync(capability.walk("", { symlinkPolicy: "skip", order: "filesystem", maxEntries }));
    expect(entries.filter(entry => entry.kind === "file")).toHaveLength(maxEntries);
    expect(entries.some(entry => entry.kind === "truncated")).toBe(maxEntries < 128);
  }
}, 30_000);

it.each(["async", "sync"] as const)("closes a bounded standalone stream when a callback throws (%s)", async mode => {
  const directory = await tempRoot("fs-safe-budget-close-");
  await fs.writeFile(path.join(directory, "file"), "value");
  const close = vi.spyOn(fsSync.Dir.prototype, mode === "async" ? "close" : "closeSync");
  const failure = new Error("filter failed");
  const call = async () => (mode === "async" ? walkDirectory : walkDirectorySync)(directory, {
    maxEntries: 10, include: () => { throw failure; },
  });
  await expect(call()).rejects.toBe(failure);
  // Node implements promise-based close by calling the callback overload.
  expect(close.mock.calls.filter(args => args.length === 0)).toHaveLength(1);
});
