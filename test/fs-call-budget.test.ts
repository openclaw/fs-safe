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
  "root.readBytes": 14, // measured 12
  readRegularFile: 8, // measured 6
  tryReadJson: 9, // measured 7
  replaceFileAtomic: 18, // measured 16
  "writeJson durable:false": 18, // measured 16
  "root.write": 56, // measured 54, including canonical mode-inheritance identity
  "root.exists": 7, // measured 5
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
          value: function (this: unknown, ...args: unknown[]) {
            if (counting) counts.set(prefix + key, (counts.get(prefix + key) ?? 0) + 1);
            return Reflect.apply(original, this, args);
          },
        });
        restore.push(() => Object.defineProperty(object, key, descriptor));
      }
    };
    try {
      wrap(fs, Object.keys(fs), "p.");
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
        expect.soft(total, `${name}: ${total} calls; ${breakdown}`).toBeLessThanOrEqual(budgets[name]);
      }
    } finally {
      counting = false;
      for (const undo of restore.reverse()) undo();
      configureFsSafeNative({ mode: "auto" });
    }
  });
});
