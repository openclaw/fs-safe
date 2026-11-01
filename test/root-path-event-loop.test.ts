import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it("keeps the event loop responsive while a Root read waits on a path lookup", async () => {
  const directory = await tempRoot("fs-safe-root-read-delay-");
  const target = path.join(directory, "nested", "file.txt");
  await asyncFs.mkdir(path.dirname(target));
  await asyncFs.writeFile(target, "payload");
  const handle = await root(directory);
  const lookup = path.dirname(target);
  const actualSync = fs.lstatSync;
  const actualAsync = asyncFs.lstat;
  let pending = false;
  let progressed = false;
  let delays = 0;
  const heartbeat = setInterval(() => { progressed ||= pending; }, 1);
  vi.spyOn(fs, "lstatSync").mockImplementation(((candidate, options) => {
    if (candidate === lookup) {
      pending = true;
      delays++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      pending = false;
    }
    return actualSync(candidate, options);
  }) as typeof fs.lstatSync);
  vi.spyOn(asyncFs, "lstat").mockImplementation((async (candidate, options) => {
    if (candidate === lookup) {
      pending = true;
      delays++;
      await delay(50);
      pending = false;
    }
    return actualAsync(candidate, options);
  }) as typeof asyncFs.lstat);
  try {
    const result = await handle.read("nested/file.txt");
    expect(result.buffer.toString()).toBe("payload");
    expect(delays).toBeGreaterThan(0);
    expect(progressed).toBe(true);
  } finally {
    clearInterval(heartbeat);
  }
});
