import { createHook } from "node:async_hooks";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceFileAtomic } from "../src/atomic.js";
import { configureFsSafeNative } from "../src/config.js";
import { createFileSync } from "../src/create.js";
import { tryReadJson, writeJson } from "../src/json.js";
import { readRegularFile } from "../src/regular-file.js";
import { readLocalFileSafely, root } from "../src/root.js";
import { __loadBundledNativeForTest } from "../src/native.js";
import { useRealTempDirs } from "./helpers/vitest.js";

// Measured fallback calls on macOS; allow two calls for platform variation,
// except for the exact root.readBytes final-fence ceiling.
const budgets = {
  "root.readBytes": 16, // one final admission: four identities, canonicalization, and EOF size
  readLocalFileSafely: 9,
  readRegularFile: 9, // measured 7
  tryReadJson: 10, // measured 8
  replaceFileAtomic: 20, // measured 18
  "writeJson durable:false": 20, // measured 18
  "root.write": 60, // measured 58, including canonical mode-inheritance identity
  "root.create": 34,
  createFileSync: 10,
  "root.exists": 7, // exact direct-child admission and final root path fence
};
const asyncBudgets = {
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
};
const { tempRoot } = useRealTempDirs();

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
      };
      for (const name of Object.keys(budgets) as Array<keyof typeof budgets>) {
        await operations[name]();
        counts.clear();
        nonthrowingTargetProbes = 0;
        counting = true;
        try { await operations[name](); } finally { counting = false; }
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
          expect.soft(total, breakdown).toBe(16);
          expect.soft(asyncTotal, breakdown).toBe(3); // open, read, close
        }
        if (name === "readLocalFileSafely") {
          expect.soft(total, breakdown).toBe(9);
          expect.soft(counts.get("s.statSync"), breakdown).toBe(1);
          expect.soft(counts.get(process.platform === "linux" ? "s.readlinkSync" : "s.realpathSync.native"), breakdown).toBe(1);
          if (process.platform === "linux") expect.soft(counts.get("s.realpathSync.native"), breakdown).toBeUndefined();
        }
      }
    } finally {
      counting = false;
      for (const undo of restore.reverse()) undo();
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
        const hook = createHook({ init(_id, type) { if (type === "PROMISE") promises++; } });
        try {
          wrap(fs, Object.keys(fs), "p.");
          wrap(fsSync.realpathSync, ["native"], "s.realpathSync.");
          wrap(fsSync, Object.keys(fsSync).filter(key => key.endsWith("Sync")), "s.");
          hook.enable();
          await scoped.move("source", "target", { overwrite });
        } finally {
          hook.disable();
          for (const undo of restore.reverse()) undo();
        }
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        const asyncTotal = [...counts].reduce((sum, [name, count]) => sum + (name.startsWith("p.") ? count : 0), 0);
        const breakdown = JSON.stringify(Object.fromEntries(counts));
        expect(promises, breakdown).toBe(overwrite && mode !== "require" ? 82 : 73);
        if (process.platform !== "win32") {
          const callBudget = overwrite ? mode === "require" ? 38 : 33 : mode === "auto" && process.platform === "linux" ? 37 : 36;
          expect(total, breakdown).toBe(callBudget);
          expect(counts.get("s.realpathSync.native"), breakdown).toBe(4);
        }
        expect(asyncTotal).toBe(mode === "require" || !overwrite ? 0 : 1);
        expect(fsSync.readFileSync(target, "utf8")).toBe("source");
        expect(fsSync.existsSync(source)).toBe(false);
      }
    });
  }
});
