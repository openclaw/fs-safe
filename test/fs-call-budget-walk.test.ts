import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { expect, it } from "vitest";
import { configureFsSafeNative } from "../src/config.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

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
      const measuredWalk = new AsyncLocalStorage<boolean>();
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
        // Other runner work can create promises while the directory read is pending.
        if (!measuredWalk.getStore()) return;
        if (type === "PROMISE") promises++;
        if (type === "FSREQPROMISE") asyncFs++;
      } });
      hook.enable();
      let entries = 0;
      try {
        await measuredWalk.run(true, async () => {
          for await (const _entry of capability.walk("", { symlinkPolicy: "skip" })) entries++;
        });
      } finally {
        hook.disable();
        measuredWalk.disable();
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
