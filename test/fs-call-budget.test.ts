import { AsyncLocalStorage, createHook } from "node:async_hooks";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomic } from "../src/atomic.js";
import { configureFsSafeNative } from "../src/config.js";
import { createFileSync } from "../src/create.js";
import { tryReadJson, writeJson } from "../src/json.js";
import { readRegularFile } from "../src/regular-file.js";
import { readLocalFileSafely, root } from "../src/root.js";
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
};
// Includes the instrumentation wrapper around open; metadata checks add no promises.
const promiseBudgets = { "root.readBytes": 51, readLocalFileSafely: 47, "root.open": 35, "readLocalFileSafely bounded": 46 };
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
      }
    } finally {
      hook.disable();
      counting = false;
      for (const undo of restore.reverse()) undo();
      configureFsSafeNative({ mode: "auto" });
    }
  });
});
