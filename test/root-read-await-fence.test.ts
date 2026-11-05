import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
import * as realpath from "../src/realpath.js";
import { openRootFile } from "../src/root-file.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { expectClosedWithoutReading, observeOpenedHandle } from "./helpers/root-read-observer.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

itPosix.each(["root", "leaf"] as const)("rejects a %s replacement while final admission awaits", async replacement => {
  const base = await tempRoot("fs-safe-read-await-");
  const directory = path.join(base, "root");
  const filePath = path.join(directory, "value");
  await fs.mkdir(directory);
  await fs.writeFile(filePath, "original");
  const scoped = await root(directory);
  const observed = observeOpenedHandle(filePath);
  let final = false, swapped = false;
  __setFsSafeTestHooksForTest({
    afterOpen: observed.hook,
    beforeRootReadFinalFence() { final = true; },
  });
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const stat = await lstat(...args);
    if (final && !swapped && String(args[0]) === (replacement === "root" ? directory : filePath)) {
      swapped = true;
      if (replacement === "root") {
        await fs.rename(directory, path.join(base, "displaced"));
        await fs.mkdir(directory);
      } else await fs.rename(filePath, path.join(directory, "displaced"));
      await fs.writeFile(filePath, "replacement");
    }
    return stat;
  });
  await expect(scoped.readText("value")).rejects.toMatchObject({ code: "path-mismatch" });
  expect(swapped).toBe(true);
  expectClosedWithoutReading(observed);
});

itPosix("rejects a root-file canonical leaf replaced during awaited final resolution", async () => {
  const directory = await tempRoot("fs-safe-root-file-await-");
  const filePath = path.join(directory, "value");
  await fs.writeFile(filePath, "original");
  const resolve = realpath.realpathNative;
  let swapped = false;
  vi.spyOn(realpath, "realpathNative").mockImplementation(async candidate => {
    const canonical = await resolve(candidate);
    if (!swapped && candidate === filePath) {
      swapped = true;
      await fs.rename(filePath, path.join(directory, "displaced"));
      await fs.writeFile(filePath, "replacement");
    }
    return canonical;
  });
  const opened = await openRootFile({ absolutePath: filePath, rootPath: directory, boundaryLabel: "fixture" });
  expect(swapped).toBe(true);
  expect(opened).toMatchObject({ ok: false, reason: "validation", error: { code: "path-mismatch" } });
});

itPosix("retains the Windows final fence without yielding between root observations", async () => {
  const directory = await tempRoot("fs-safe-windows-final-order-");
  await fs.writeFile(path.join(directory, "value"), "payload");
  const scoped = await root(directory);
  Object.defineProperty(process, "platform", { value: "win32" });
  let final = false, observations = 0, yielded = false;
  __setFsSafeTestHooksForTest({ beforeRootReadFinalFence() { final = true; } });
  const lstat = fsSync.lstatSync.bind(fsSync);
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    if (final && String(args[0]) === directory) {
      expect(yielded).toBe(false);
      if (++observations === 1) queueMicrotask(() => { yielded = true; });
    }
    return lstat(...args);
  });
  const opened = await scoped.open("value");
  try { expect(observations).toBe(2); }
  finally { await opened.handle.close(); }
});
