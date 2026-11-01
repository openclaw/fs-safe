import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncResource, createHook } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { metadataPromiseOverhead } from "../scripts/native-call-budget-resources.mjs";
import { configureFsSafeNative } from "../src/config.js";
import { __loadBundledNativeForTest } from "../src/native.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

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
        // Traversal offloads 9 lstat, 7 stat and 1 realpath calls without extra observations.
        // Missing targets also schedule rejected metadata probes (+16 promises).
        expect(["p.lstat", "p.stat", "p.realpath"].map(name => counts.get(name) ?? 0), breakdown).toEqual([9, 7, 1]);
        const traversalPromises = overwrite ? 101 : 117;
        expect(promises, breakdown).toBe((overwrite && mode !== "require" ? 82 : 73) + traversalPromises + metadataPromiseOverhead(16));
        if (process.platform !== "win32") {
          const callBudget = overwrite ? mode === "require" ? 36 : 33 : mode === "auto" && process.platform === "linux" ? 35 : 34;
          expect(total, breakdown).toBe(callBudget);
          expect((counts.get("s.realpathSync.native") ?? 0) + (counts.get("p.realpath") ?? 0), breakdown).toBe(overwrite && mode !== "require" ? 4 : 3);
        }
        expect(asyncTotal).toBe(17 + (mode === "require" || !overwrite ? 0 : 1));
        expect(fsSync.readFileSync(target, "utf8")).toBe("source");
        expect(fsSync.existsSync(source)).toBe(false);
      }
    });
  }
});
