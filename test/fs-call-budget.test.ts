import { execFileSync } from "node:child_process";
import { AsyncLocalStorage, AsyncResource, createHook } from "node:async_hooks";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { replaceFileAtomic } from "../src/atomic.js";
import { configureFsSafeNative } from "../src/config.js";
import { assertCopySourceCurrent } from "../src/copy-file-input.js";
import { createFileSync } from "../src/create.js";
import { sha256File, sha256FileSync } from "../src/file-hash.js";
import { tryReadJson, writeJson } from "../src/json.js";
import { readRegularFile } from "../src/regular-file.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { readLocalFileSafely, root } from "../src/root.js";
import { tempWorkspace, tempWorkspaceSync } from "../src/temp.js";
import { loadTestNative, loadWindowsSimulationNative } from "./helpers/native-probe.js";
import { useRealTempDirs } from "./helpers/vitest.js";

// Measured fallback calls on macOS; allow two calls for platform variation,
// except for the exact root.readBytes final-fence ceiling.
const budgets = {
  "root.open": 13, // includes caller close, excludes reading bytes
  "readLocalFileSafely bounded": 10,
  "root.readBytes": 15, // final admission plus fresh EOF size; initial allocation reuses the receipt
  readLocalFileSafely: 9,
  readRegularFile: 9, // measured 7
  tryReadJson: 10, // measured 8
  replaceFileAtomic: 20, // measured 18
  "writeJson durable:false": 20, // measured 18
  "root.write": 60, // measured 58, including canonical mode-inheritance identity
  "root.create": 34,
  createFileSync: 10,
  "root.exists": 7, // exact direct-child admission and final root path fence
  sha256File: 8, // two pathname checks, two descriptor checks, open/read/EOF/close
  sha256FileSync: 8,
  "root.copyIn durable:false": 48,
};
const asyncBudgets = {
  "root.open": 2, // open and caller close
  "readLocalFileSafely bounded": 3,
  "root.readBytes": 4, // measured 3: open, read, close
  readLocalFileSafely: 3,
  readRegularFile: 4, // measured 3: open, readFile, close
  tryReadJson: 4, // measured 3: open, readFile, close
  replaceFileAtomic: 9, // measured 8
  "writeJson durable:false": 9, // measured 8
  "root.write": 12, // measured 11, including two durability syncs
  "root.create": 3,
  createFileSync: 0,
  "root.exists": 1, // measured 0
  sha256File: 4, // open, payload read, EOF read, close
  sha256FileSync: 0,
  "root.copyIn durable:false": 9,
};
// Includes the instrumentation wrapper around open; metadata checks add no promises.
const promiseBudgets = { "root.readBytes": 51, readLocalFileSafely: 47, "root.open": 35, "readLocalFileSafely bounded": 46 };
const { tempRoot } = useRealTempDirs();

describe("Root.list filename allocation budget", () => {
  it.each([1000, 50000])("does not materialize filename buffers for %i ordinary names", async count => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-list-name-budget-");
    const safe = await root(directory);
    const names = Array.from({ length: count }, (_, index) => String(index));
    let materializedBuffers = 0;
    const readdir = vi.spyOn(fs, "readdir").mockImplementation((async (_path, options) => {
      if (typeof options === "object" && options?.encoding === "buffer") {
        materializedBuffers += names.length;
        return names.map(name => Buffer.from(name));
      }
      return [...names];
    }) as typeof fs.readdir);
    try {
      expect(await safe.list("")).toEqual([...names].sort());
      expect(readdir).toHaveBeenCalledTimes(1);
      expect(materializedBuffers).toBe(0);
    } finally {
      readdir.mockRestore();
      configureFsSafeNative({ mode: "auto" });
    }
  });

  it("re-reads a suspect batch as raw bytes while preserving literal replacement characters", async () => {
    const directory = await tempRoot("fs-safe-list-replacement-budget-");
    await fs.writeFile(path.join(directory, "\ufffd"), "valid UTF-8");
    const safe = await root(directory);
    const readdir = vi.spyOn(fs, "readdir");
    try {
      expect(await safe.list("")).toEqual(["\ufffd"]);
      expect(readdir.mock.calls.map(([, options]) => options)).toEqual([undefined, { encoding: "buffer" }]);
    } finally {
      readdir.mockRestore();
    }
  });
});

describe.skipIf(process.platform === "win32")("fallback filesystem call budgets", () => {
  it("keeps each operation within its syscall budget", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-call-budget-");
    const safe = await root(directory, { mkdir: true });
    await fs.writeFile(path.join(directory, "r.txt"), "hi");
    await fs.writeFile(path.join(directory, "j.json"), "{}");
    const handle = await fs.open(path.join(directory, "r.txt"), "r");
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const counts = new Map<string, number>();
    const restore: Array<() => void> = [];
    let counting = false;
    let nonthrowingTargetProbes = 0;
    let promises = 0;
    const promiseScope = new AsyncLocalStorage<object>();
    let currentScope: object;
    const hook = createHook({ init(_, type) {
      if (counting && type === "PROMISE" && promiseScope.getStore() === currentScope) promises++;
    } });
    hook.enable();
    const wrap = (object: object, keys: string[], prefix: string) => {
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor?.writable || typeof descriptor.value !== "function") continue;
        const original = descriptor.value;
        Object.defineProperty(object, key, {
          ...descriptor,
          value: Object.assign(function (this: unknown, ...args: unknown[]) {
            if (counting) {
              counts.set(prefix + key, (counts.get(prefix + key) ?? 0) + 1);
              if (prefix === "s." && key === "statSync" &&
                (args[1] as { throwIfNoEntry?: boolean } | undefined)?.throwIfNoEntry === false) nonthrowingTargetProbes++;
            }
            const result = Reflect.apply(original, this, args);
            if (prefix === "p." && key === "open") {
              return result.then((opened: object) => {
                // FileHandle.close is an own property, not a prototype method.
                wrap(opened, ["close"], "h.");
                return opened;
              });
            }
            return result;
          }, original),
        });
        restore.push(() => Object.defineProperty(object, key, descriptor));
      }
    };
    try {
      wrap(fs, Object.keys(fs), "p.");
      wrap(fsSync.realpathSync, ["native"], "s.realpathSync.");
      wrap(fsSync, Object.keys(fsSync).filter((key) => key.endsWith("Sync") && key !== "writeSync"), "s.");
      wrap(prototype, Object.getOwnPropertyNames(prototype).filter((key) => key !== "constructor" && key !== "fd"), "h.");
      let createSequence = 0;
      const operations: Record<keyof typeof budgets, () => Promise<unknown>> = {
        "root.open": async () => { const opened = await safe.open("r.txt"); await opened.handle.close(); },
        "readLocalFileSafely bounded": () => readLocalFileSafely({ filePath: path.join(directory, "r.txt"), maxBytes: 2 }),
        "root.readBytes": () => safe.readBytes("r.txt"),
        readLocalFileSafely: () => readLocalFileSafely({ filePath: path.join(directory, "r.txt") }),
        readRegularFile: () => readRegularFile({ filePath: path.join(directory, "r.txt") }),
        tryReadJson: () => tryReadJson(path.join(directory, "j.json")),
        replaceFileAtomic: () => replaceFileAtomic({ filePath: path.join(directory, "a.txt"), content: "x" }),
        "writeJson durable:false": () => writeJson(path.join(directory, "w.json"), { a: 1 }, { durable: false }),
        "root.write": () => safe.write("w.txt", "x"),
        "root.create": () => safe.create(`created-${createSequence++}`, "x", { durable: false }),
        createFileSync: async () => createFileSync(path.join(directory, `exclusive-${createSequence++}`)).close(),
        "root.exists": () => safe.exists("r.txt"),
        sha256File: () => sha256File(path.join(directory, "r.txt")),
        sha256FileSync: async () => sha256FileSync(path.join(directory, "r.txt")),
        "root.copyIn durable:false": () => safe.copyIn("copy.txt", path.join(directory, "r.txt"), { durable: false }),
      };
      for (const name of Object.keys(budgets) as Array<keyof typeof budgets>) {
        await operations[name]();
        counts.clear();
        nonthrowingTargetProbes = 0;
        promises = 0;
        currentScope = {};
        counting = true;
        try { await promiseScope.run(currentScope, operations[name]); } finally { counting = false; }
        if (name in promiseBudgets) {
          expect.soft(promises, `${name} promises`).toBeLessThanOrEqual(promiseBudgets[name as keyof typeof promiseBudgets]);
        }
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        const breakdown = [...counts].map(([key, count]) => `${key}=${count}`).join(" ");
        const asyncTotal = [...counts].reduce((sum, [key, count]) =>
          sum + (key.startsWith("s.") ? 0 : count), 0);
        expect.soft(total, `${name}: ${total} calls; ${breakdown}`).toBeLessThanOrEqual(budgets[name]);
        expect.soft(asyncTotal, `${name}: ${asyncTotal} async calls; ${breakdown}`)
          .toBeLessThanOrEqual(asyncBudgets[name]);
        if (name === "root.create") expect.soft(nonthrowingTargetProbes).toBe(1);
        if (name === "root.create" || name === "createFileSync") {
          expect.soft(total, breakdown).toBe(name === "root.create" ? 34 : 10);
          expect.soft(asyncTotal, breakdown).toBe(name === "root.create" ? 3 : 0);
        }
        if (name === "root.readBytes") {
          expect.soft(total, breakdown).toBe(15);
          expect.soft(asyncTotal, breakdown).toBe(3); // open, read, close
        }
        if (name === "readLocalFileSafely") {
          expect.soft(total, breakdown).toBe(9);
          expect.soft(counts.get("s.statSync"), breakdown).toBe(1);
          expect.soft(counts.get(process.platform === "linux" ? "s.readlinkSync" : "s.realpathSync.native"), breakdown).toBe(1);
          if (process.platform === "linux") expect.soft(counts.get("s.realpathSync.native"), breakdown).toBeUndefined();
        }
        if (name === "sha256File" || name === "sha256FileSync") {
          expect.soft(total, breakdown).toBe(8);
          expect.soft(asyncTotal, breakdown).toBe(name === "sha256File" ? 4 : 0);
          expect.soft(counts.get("s.lstatSync"), breakdown).toBe(2);
          expect.soft(counts.get("s.fstatSync"), breakdown).toBe(2);
          expect.soft(counts.get(name === "sha256File" ? "h.read" : "s.readSync"), breakdown).toBe(2);
        }
      }
    } finally {
      hook.disable();
      counting = false;
      for (const undo of restore.reverse()) undo();
      configureFsSafeNative({ mode: "auto" });
    }
  });
});

// Copy admission has independent native/fallback paths and an operation-local
// directory cache. Pin cold single-copy and warm batch costs separately.
describe("synchronous copy admission budgets", () => {
  it("keeps fresh directory checks within the fallback budget", async () => {
    const { copyRootFileSync, createRootFileCopyBatchSync } = await import("../src/advanced.js");
    const directory = fsSync.realpathSync(await tempRoot("fs-safe-copy-budget-"));
    fsSync.mkdirSync(path.join(directory, "nested"));
    for (const parent of [directory, path.join(directory, "nested")]) fsSync.writeFileSync(path.join(parent, "input"), "hi");
    const restore: Array<() => void> = [];
    const counts = new Map<string, number>();
    let counting = false;
    const wrap = (object: object, keys: string[], prefix: string) => {
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor?.writable || typeof descriptor.value !== "function") continue;
        const original = descriptor.value;
        Object.defineProperty(object, key, { ...descriptor, value: Object.assign(function (this: unknown, ...args: unknown[]) {
          if (counting) counts.set(prefix + key, (counts.get(prefix + key) ?? 0) + 1);
          return Reflect.apply(original, this, args);
        }, original) });
        restore.push(() => Object.defineProperty(object, key, descriptor));
      }
    };
    configureFsSafeNative({ mode: "off" });
    try {
      wrap(fsSync.realpathSync, ["native"], "s.realpathSync.");
      wrap(fsSync, Object.keys(fsSync).filter(key => key.endsWith("Sync")), "s.");
      wrap(fs, Object.keys(fs), "p.");
      for (const nested of [false, true]) for (const batched of [false, true]) {
        using batch = createRootFileCopyBatchSync();
        const parent = nested ? path.join(directory, "nested") : directory;
        const options = (suffix: string) => ({
          source: { rootPath: directory, absolutePath: path.join(parent, "input") },
          destination: { rootPath: directory, absolutePath: path.join(parent, `${nested}-${batched}-${suffix}`) },
        });
        if (batched) batch.copyFile(options("warmup")).close();
        counts.clear();
        counting = true;
        const copied = batched ? batch.copyFile(options("measured")) : copyRootFileSync(options("measured"));
        counting = false;
        copied.close();
        const detail = `${nested ? "nested" : "direct"} ${batched ? "batch" : "single"}: ${JSON.stringify([...counts])}`;
        const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
        // Windows exclusive creation adds two leaf checks and one canonical check.
        const windows = process.platform === "win32";
        const totalBudget = nested ? (batched ? 123 : 150) : (batched ? 102 : 123);
        const lstatBudget = nested ? (batched ? 61 : 75) : (batched ? 50 : 60);
        expect.soft(total, detail).toBe(totalBudget + (windows ? 3 : 0));
        expect.soft(counts.get("s.lstatSync"), detail).toBe(lstatBudget + (windows ? 2 : 0));
        expect.soft([...counts].filter(([key]) => key.startsWith("p.")), detail).toEqual([]);
      }
    } finally {
      counting = false;
      for (const undo of restore.reverse()) undo();
      configureFsSafeNative({ mode: "auto" });
    }
  });
});

describe("empty temp workspace cleanup call budgets", () => {
  it.each(["async", "sync"] as const)("holds %s cleanup to its platform call budget", async (variant) => {
    configureFsSafeNative({ mode: "off" });
    const rootDir = await tempRoot("fs-safe-temp-cleanup-budget-");
    const options = { rootDir, prefix: "workspace-" };
    const workspace = variant === "async" ? await tempWorkspace(options) : tempWorkspaceSync(options);
    const named = vi.spyOn(fsSync, "lstatSync");
    const descriptor = vi.spyOn(fsSync, "fstatSync");
    const canonical = vi.spyOn(fsSync.realpathSync, "native");
    const rmdir = vi.spyOn(fs, "rmdir");
    const rmdirSync = vi.spyOn(fsSync, "rmdirSync");
    const rm = vi.spyOn(fs, "rm");
    const rmSync = vi.spyOn(fsSync, "rmSync");
    const requests: string[] = [];
    const hook = createHook({ init: (_id, type) => {
      if (type.startsWith("FSREQ")) requests.push(type);
    } });
    try {
      hook.enable();
      expect(await workspace.cleanup()).toBe("removed");
      hook.disable();
      expect(named).toHaveBeenCalledTimes(10);
      expect(descriptor).toHaveBeenCalledTimes(7);
      expect(canonical).toHaveBeenCalledTimes(7);
      const windows = process.platform === "win32";
      expect(rmdir).toHaveBeenCalledTimes(!windows && variant === "async" ? 1 : 0);
      expect(rmdirSync).toHaveBeenCalledTimes(!windows && variant === "sync" ? 1 : 0);
      expect(rm).toHaveBeenCalledTimes(windows && variant === "async" ? 1 : 0);
      expect(rmSync).toHaveBeenCalledTimes(windows && variant === "sync" ? 1 : 0);
      expect(requests).toEqual(variant === "sync" ? []
        : windows ? ["FSREQCALLBACK", "FSREQCALLBACK", "FSREQCALLBACK"] : ["FSREQPROMISE"]);
    } finally {
      hook.disable();
      vi.restoreAllMocks();
      configureFsSafeNative({ mode: "auto" });
    }
  });
});

describe("recursive removal observation budgets", () => {
  let nativeRemoval: ReturnType<typeof __loadBundledNativeForTest> | undefined;
  try { if (process.platform !== "win32") nativeRemoval = __loadBundledNativeForTest(); }
  catch { /* The fallback budget runs without an installed binding. */ }
  it.each(["off", ...(nativeRemoval?.openRootRemovalDirectory ? ["require"] : [])] as const)("keeps every %s directory fence while avoiding repeated BigIntStats allocation", async mode => {
    configureFsSafeNative({ mode });
    const directory = await tempRoot("fs-safe-remove-call-budget-");
    const safe = await root(directory);
    const tree = path.join(safe.rootReal, "tree");
    await fs.mkdir(tree);
    await fs.writeFile(path.join(tree, "leaf"), "value");
    if (mode === "require") {
      const parent = fsSync.openSync(safe.rootReal, fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0));
      let available: boolean;
      try { available = nativeRemoval?.ownedTreeRemovalAvailable?.(parent) === true; }
      finally { fsSync.closeSync(parent); }
      // The export can exist even when the kernel cannot confine recursion.
      if (!available) {
        try {
          await expect(safe.remove("tree", { recursive: true })).rejects.toMatchObject({ code: "helper-unavailable" });
          expect(await fs.readFile(path.join(tree, "leaf"), "utf8")).toBe("value");
        } finally { configureFsSafeNative({ mode: "auto" }); }
        return;
      }
    }
    const boundaries = new Set([safe.rootReal, tree]);
    const observations = { exact: 0, numeric: 0, canonical: 0 };
    const lstat = fsSync.lstatSync.bind(fsSync);
    const realpath = fsSync.realpathSync.native;
    const safeIds = [...boundaries].every(boundary => {
      const stat = lstat(boundary, { bigint: true });
      return stat.dev > 0n && stat.ino > 0n &&
        stat.dev <= BigInt(Number.MAX_SAFE_INTEGER) && stat.ino <= BigInt(Number.MAX_SAFE_INTEGER);
    });
    const statSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      if (boundaries.has(String(args[0]))) {
        observations[(args[1] as { bigint?: boolean } | undefined)?.bigint ? "exact" : "numeric"]++;
      }
      return lstat(...args);
    }) as typeof fsSync.lstatSync);
    const realpathSpy = vi.spyOn(fsSync.realpathSync, "native").mockImplementation((...args) => {
      if (boundaries.has(String(args[0]))) observations.canonical++;
      return realpath(...args);
    });
    try {
      await safe.remove("tree", { recursive: true });
      const expected = mode === "require"
        ? { exact: 3, numeric: 13, canonical: 14 }
        : { exact: 6, numeric: 20, canonical: 21 };
      if (safeIds) {
        expect(observations).toEqual(expected);
      } else {
        expect(observations.canonical).toBe(expected.canonical);
        expect(observations.exact + observations.numeric).toBeGreaterThanOrEqual(expected.exact + expected.numeric);
      }
    } finally {
      statSpy.mockRestore();
      realpathSpy.mockRestore();
      configureFsSafeNative({ mode: "auto" });
    }
  });
});

// Move owns no FileHandles: the fallback dispatches rename, while native move
// owns and closes synchronous descriptors inside its admission helpers.
let moveNativeAvailable = false;
try { moveNativeAvailable = typeof __loadBundledNativeForTest().renameReplaceWithIdentity === "function"; }
catch { /* Off mode needs no addon. */ }
describe("move filesystem call budgets", () => {
  afterEach(() => configureFsSafeNative({ mode: "auto" }));
  for (const mode of ["off", "auto", "require"] as const) {
    it.skipIf(mode !== "off" && !moveNativeAvailable)(`pins move observations in ${mode} mode`, async () => {
      configureFsSafeNative({ mode });
      const directory = await tempRoot("fs-safe-move-budget-");
      const scoped = await root(directory);
      const source = path.join(directory, "source");
      const target = path.join(directory, "target");
      for (const overwrite of mode === "off" ? [true] : [true, false]) {
        const prepare = () => {
          fsSync.writeFileSync(source, "source");
          if (overwrite) fsSync.writeFileSync(target, "target");
          else fsSync.rmSync(target, { force: true });
        };
        prepare();
        await scoped.move("source", "target", { overwrite });
        prepare();
        const counts = new Map<string, number>();
        const restore: Array<() => void> = [];
        const wrap = (object: object, keys: string[], prefix: string) => {
          for (const key of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            if (!descriptor?.writable || typeof descriptor.value !== "function") continue;
            const original = descriptor.value;
            Object.defineProperty(object, key, { ...descriptor, value: Object.assign(function (this: unknown, ...args: unknown[]) {
              counts.set(prefix + key, (counts.get(prefix + key) ?? 0) + 1);
              return Reflect.apply(original, this, args);
            }, original) });
            restore.push(() => Object.defineProperty(object, key, descriptor));
          }
        };
        let promises = 0;
        // Exclude runner work that happens while the asynchronous rename is pending.
        const operation = new AsyncResource("fs-safe-move-budget");
        const descendants = new Set([operation.asyncId()]);
        const hook = createHook({ init(id, type, trigger) {
          if (!descendants.has(trigger)) return;
          descendants.add(id);
          if (type === "PROMISE") promises++;
        } });
        try {
          wrap(fs, Object.keys(fs), "p.");
          wrap(fsSync.realpathSync, ["native"], "s.realpathSync.");
          wrap(fsSync, Object.keys(fsSync).filter(key => key.endsWith("Sync")), "s.");
          hook.enable();
          await Promise.resolve();
          expect(promises).toBe(0);
          await operation.runInAsyncScope(() => scoped.move("source", "target", { overwrite }));
        } finally {
          hook.disable();
          operation.emitDestroy();
          for (const undo of restore.reverse()) undo();
        }
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        const asyncTotal = [...counts].reduce((sum, [name, count]) => sum + (name.startsWith("p.") ? count : 0), 0);
        const breakdown = JSON.stringify(Object.fromEntries(counts));
        expect(promises, breakdown).toBe(overwrite && mode !== "require" ? 82 : 73);
        if (process.platform !== "win32") {
          const callBudget = overwrite ? mode === "require" ? 36 : 33 : mode === "auto" && process.platform === "linux" ? 35 : 34;
          expect(total, breakdown).toBe(callBudget);
          expect(counts.get("s.realpathSync.native"), breakdown).toBe(overwrite && mode !== "require" ? 4 : 3);
        }
        expect(asyncTotal).toBe(mode === "require" || !overwrite ? 0 : 1);
        expect(fsSync.readFileSync(target, "utf8")).toBe("source");
        expect(fsSync.existsSync(source)).toBe(false);
      }
    });
  }
});

// Four promises per additional entry belong to the public async-generator protocol.
// Snapshot consumption must not add another promise pair or delegation layer.
it("bounds flat-walk promises without adding filesystem observations", async () => {
  configureFsSafeNative({ mode: "off" });
  try {
    const directory = await tempRoot("fs-safe-walk-promises-");
    const capability = await root(directory);
    const counts = [];
    for (const width of [64, 128]) {
      for (let index = 0; index < width; index++) {
        fsSync.writeFileSync(path.join(directory, `${index}`), "");
      }
      let promises = 0, asyncFs = 0, lstat = 0, readdir = 0;
      const lstatDescriptor = Object.getOwnPropertyDescriptor(fsSync, "lstatSync")!;
      const readdirDescriptor = Object.getOwnPropertyDescriptor(fs, "readdir")!;
      Object.defineProperty(fsSync, "lstatSync", {
        ...lstatDescriptor,
        value: (...args: unknown[]) => { lstat++; return Reflect.apply(lstatDescriptor.value, fsSync, args); },
      });
      Object.defineProperty(fs, "readdir", {
        ...readdirDescriptor,
        value: (...args: unknown[]) => { readdir++; return Reflect.apply(readdirDescriptor.value, fs, args); },
      });
      const hook = createHook({ init(_id, type) {
        if (type === "PROMISE") promises++;
        if (type === "FSREQPROMISE") asyncFs++;
      } });
      hook.enable();
      let entries = 0;
      try {
        for await (const _entry of capability.walk("", { symlinkPolicy: "skip" })) entries++;
      } finally {
        hook.disable();
        Object.defineProperty(fsSync, "lstatSync", lstatDescriptor);
        Object.defineProperty(fs, "readdir", readdirDescriptor);
      }
      counts.push({ promises, entries, lstat, readdir, asyncFs });
    }
    expect(counts[1]!.entries - counts[0]!.entries).toBe(64);
    // Leave room for test-runner bookkeeping, but not another per-entry pair.
    expect(counts[1]!.promises - counts[0]!.promises).toBeLessThanOrEqual(4 * 64 + 16);
    expect(counts[1]!.lstat - counts[0]!.lstat).toBe(64);
    expect(counts.map(count => count.readdir)).toEqual([1, 1]);
    expect(counts[1]!.asyncFs).toBe(counts[0]!.asyncFs);
  } finally { configureFsSafeNative({ mode: "auto" }); }
});

it.skipIf(Boolean(process.versions.bun))("keeps async hash admission free of metadata promise adapters", async () => {
  const directory = await tempRoot("fs-safe-hash-promises-");
  const file = path.join(directory, "input");
  await fs.writeFile(file, "hash budget");
  // Coverage and test-runner activity create unrelated promises in this process.
  const resources = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { createHook } from "node:async_hooks";
    import { sha256File } from "./dist/file-hash.js";
    import { configureFsSafeNative } from "./dist/config.js";
    configureFsSafeNative({ mode: "off" });
    await sha256File(process.argv[1]);
    const resources = {};
    const hook = createHook({
      init(_id, type) { resources[type] = (resources[type] ?? 0) + 1; },
    });
    hook.enable();
    await sha256File(process.argv[1]);
    hook.disable();
    console.log(JSON.stringify(resources));
  `, file], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" })) as Record<string, number>;
  // Previously 47: all three exact metadata observations now stay synchronous.
  expect(resources.PROMISE).toBeLessThanOrEqual(35);
  expect(resources.FSREQPROMISE).toBe(3);
  expect(resources.FILEHANDLECLOSEREQ).toBe(1);
});

describe("uncontended raw sidecar acquisition budgets", () => {
  it.each([false, true])("avoids missing-guard exceptions and redundant parent work (sync=%s)", async (sync) => {
    const { acquireFileLock, acquireFileLockSync } = await import("../src/file-lock.js");
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-lock-budget-");
    const originalLstat = fsSync.lstatSync;
    let guardObservations = 0, guardErrors = 0;
    const lstat = vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
      const isGuard = String(args[0]).endsWith(".reclaim");
      if (isGuard) guardObservations++;
      try { return Reflect.apply(originalLstat, fsSync, args); }
      catch (error) { if (isGuard) guardErrors++; throw error; }
    }) as typeof fsSync.lstatSync);
    const mkdir = vi.spyOn(fsSync, "mkdirSync");
    const open = vi.spyOn(fs, "open");
    const syncFile = vi.spyOn(fsSync, "fsyncSync");
    const options = { payload: () => ({ pid: process.pid }), timeoutMs: 1000 };
    let held: Awaited<ReturnType<typeof acquireFileLock>> | ReturnType<typeof acquireFileLockSync> | undefined;
    try {
      held = sync ? acquireFileLockSync(path.join(directory, "state"), options)
        : await acquireFileLock(path.join(directory, "state"), options);
      expect(guardObservations).toBe(1);
      expect(guardErrors).toBe(0);
      expect(mkdir).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(sync ? 0 : 1);
      expect(syncFile).toHaveBeenCalledTimes(sync ? 1 : 0);
    } finally {
      lstat.mockRestore(); mkdir.mockRestore(); open.mockRestore(); syncFile.mockRestore();
      await held?.release();
      configureFsSafeNative({ mode: "auto" });
    }
  });
});

const writeNativeAvailable = Boolean(loadTestNative("required-env"));
describe("write metadata budgets", () => {
  for (const mode of ["off", "require"] as const) {
  it.skipIf(mode === "require" && !writeNativeAvailable)(`preserves both Windows file flushes without redundant chmod in ${mode} mode`, async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const directory = await tempRoot("fs-safe-write-windows-mode-");
    if (mode === "require") {
      const binding = loadWindowsSimulationNative();
      __setNativeLoaderForTest(() => binding);
    }
    Object.defineProperty(process, "platform", { value: "win32" });
    configureFsSafeNative({ mode });
    const safe = await root(directory);
    const open = fs.open.bind(fs);
    const fstat = fsSync.fstatSync.bind(fsSync);
    const fsync = fsSync.fsyncSync.bind(fsSync);
    const chmod = vi.spyOn(fsSync, "fchmodSync");
    let flushes = 0;
    vi.spyOn(fsSync, "fsyncSync").mockImplementation(fd => {
      if (fstat(fd).isFile()) flushes++;
      fsync(fd);
    });
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        if (fstat(handle.fd).isFile()) flushes++;
        await sync();
      });
      return handle;
    });
    try {
      await safe.write("value", "writable", { mode: 0o600 });
      expect(chmod).not.toHaveBeenCalled();
      expect(flushes).toBe(2);
      await safe.write("value", "read-only", { mode: 0o400 });
      expect(chmod).toHaveBeenCalledTimes(1);
      expect(flushes).toBe(4);
      expect(fsSync.statSync(path.join(directory, "value")).mode & 0o200).toBe(0);
    } finally {
      vi.restoreAllMocks();
      Object.defineProperty(process, "platform", platform);
      configureFsSafeNative({ mode: "auto" });
      __resetNativeLoaderForTest();
      await fs.chmod(path.join(directory, "value"), 0o600).catch(() => undefined);
    }
  });
  }
});

it("checks copy source identity without allocating promises", async () => {
  const directory = await tempRoot("fs-safe-copy-fence-budget-");
  const realPath = path.join(directory, "source");
  await fs.writeFile(realPath, "copy source");
  const handle = await fs.open(realPath, "r");
  try {
    const identity = fsSync.fstatSync(handle.fd, { bigint: true });
    let promises = 0;
    const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises++; } });
    hook.enable();
    try {
      assertCopySourceCurrent({ handle, realPath }, identity);
    } finally {
      hook.disable();
    }
    expect(promises).toBe(0);
  } finally {
    await handle.close();
  }
});

it("bounds mkdir metadata promises without adding filesystem hops", async () => {
  const { AsyncLocalStorage, createHook } = await import("node:async_hooks");
  const context = new AsyncLocalStorage<Record<string, number>>();
  const { createDirectorySync } = await import("../src/create.js");
  const directory = await tempRoot("fs-safe-mkdir-budget-");
  for (const mode of ["off"] as const) {
    configureFsSafeNative({ mode });
    const safe = await root(directory);
    const cases: Array<[string, () => unknown, () => void]> = [
      ["mkdir", () => safe.mkdir("child"), () => fsSync.rmdirSync(path.join(directory, "child"))],
      ["mkdir-recursive", () => safe.mkdir("a/b/c"), () => fsSync.rmSync(path.join(directory, "a"), { recursive: true })],
      ["ensureRoot", () => safe.ensureRoot(), () => {}],
      ["mkdir-sync", () => createDirectorySync(path.join(directory, "sync")), () => fsSync.rmdirSync(path.join(directory, "sync"))],
    ];
    const promises: Record<string, number> = { mkdir: 21, "mkdir-recursive": 21, ensureRoot: 21, "mkdir-sync": 2 };
    for (const [name, operation, cleanup] of cases) {
      await operation(); cleanup();
      const counts: Record<string, number> = {};
      const hook = createHook({ init(_id, type) {
        if (context.getStore() === counts) counts[type] = (counts[type] ?? 0) + 1;
      } });
      hook.enable();
      try { await context.run(counts, operation); } finally { hook.disable(); }
      cleanup();
      expect(counts.PROMISE ?? 0, `${mode}/${name}`).toBeLessThanOrEqual(promises[name]!);
      expect(counts.FSREQPROMISE ?? 0, `${mode}/${name}`).toBe(0);
    }
  }
  configureFsSafeNative({ mode: "auto" });
});
