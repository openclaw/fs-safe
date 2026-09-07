import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replaceFileAtomic } from "../src/atomic.js";
import { configureFsSafeNative } from "../src/config.js";
import { tryReadJson, writeJson } from "../src/json.js";
import { readRegularFile } from "../src/regular-file.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

// Measured fallback calls on macOS; allow two calls for platform variation.
const budgets = {
  "root.readBytes": 16, // measured 14, including the post-read EOF size observation
  readRegularFile: 9, // measured 7
  tryReadJson: 10, // measured 8
  replaceFileAtomic: 20, // measured 18
  "writeJson durable:false": 20, // measured 18
  "root.write": 60, // measured 58, including canonical mode-inheritance identity
  "root.exists": 7, // measured 5
};
const asyncBudgets = {
  "root.readBytes": 4, // measured 3: open, read, close
  readRegularFile: 4, // measured 3: open, readFile, close
  tryReadJson: 4, // measured 3: open, readFile, close
  replaceFileAtomic: 9, // measured 8
  "writeJson durable:false": 9, // measured 8
  "root.write": 12, // measured 11, including two durability syncs
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
    const wrap = (object: object, keys: string[], prefix: string) => {
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor?.writable || typeof descriptor.value !== "function") continue;
        const original = descriptor.value;
        Object.defineProperty(object, key, {
          ...descriptor,
          value: Object.assign(function (this: unknown, ...args: unknown[]) {
            if (counting) counts.set(prefix + key, (counts.get(prefix + key) ?? 0) + 1);
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
      const operations: Record<keyof typeof budgets, () => Promise<unknown>> = {
        "root.readBytes": () => safe.readBytes("r.txt"),
        readRegularFile: () => readRegularFile({ filePath: path.join(directory, "r.txt") }),
        tryReadJson: () => tryReadJson(path.join(directory, "j.json")),
        replaceFileAtomic: () => replaceFileAtomic({ filePath: path.join(directory, "a.txt"), content: "x" }),
        "writeJson durable:false": () => writeJson(path.join(directory, "w.json"), { a: 1 }, { durable: false }),
        "root.write": () => safe.write("w.txt", "x"),
        "root.exists": () => safe.exists("r.txt"),
      };
      for (const name of Object.keys(budgets) as Array<keyof typeof budgets>) {
        await operations[name]();
        counts.clear();
        counting = true;
        try { await operations[name](); } finally { counting = false; }
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
        const breakdown = [...counts].map(([key, count]) => `${key}=${count}`).join(" ");
        const asyncTotal = [...counts].reduce((sum, [key, count]) =>
          sum + (key.startsWith("s.") ? 0 : count), 0);
        expect.soft(total, `${name}: ${total} calls; ${breakdown}`).toBeLessThanOrEqual(budgets[name]);
        expect.soft(asyncTotal, `${name}: ${asyncTotal} async calls; ${breakdown}`)
          .toBeLessThanOrEqual(asyncBudgets[name]);
      }
    } finally {
      counting = false;
      for (const undo of restore.reverse()) undo();
      configureFsSafeNative({ mode: "auto" });
    }
  });
});
