import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, vi } from "vitest";
import { openRootFile } from "../src/root-file.js";
import { root } from "../src/root.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

itPosix.each(["acquire", "descriptor", "read", "home"] as const)(
  "keeps %s admission off the event loop while filesystem metadata waits",
  async operation => {
    const directory = await tempRoot("fs-safe-responsive-read-");
    const filePath = path.join(directory, "value");
    await asyncFs.writeFile(filePath, "payload");
    const scoped = await root(directory);
    // Settle native-loader initialization before measuring an admitted read.
    await scoped.readText("value");
    let pending = false, progressed = false, delayed = false;
    const heartbeat = setInterval(() => { progressed ||= pending; }, 1);
    const waits = new Int32Array(new SharedArrayBuffer(4));
    const spies = (["openSync", "fstatSync", "closeSync", "readlinkSync"] as const).map(method =>
      vi.spyOn(fs, method));
    spies.push(vi.spyOn(fs.realpathSync, "native"));
    for (const method of ["statSync", "lstatSync"] as const) {
      const original = fs[method];
      spies.push(vi.spyOn(fs, method).mockImplementation(((candidate, options) => {
        if (!delayed && (candidate === directory || candidate === filePath)) {
          delayed = pending = true;
          Atomics.wait(waits, 0, 0, 500);
          pending = false;
        }
        return original(candidate, options);
      }) as typeof original));
    }
    for (const method of ["stat", "lstat"] as const) {
      const original = asyncFs[method];
      vi.spyOn(asyncFs, method).mockImplementation((async (candidate, options) => {
        if (!delayed && (candidate === directory || candidate === filePath)) {
          delayed = pending = true;
          await delay(500);
          pending = false;
        }
        return original(candidate, options);
      }) as typeof original);
    }
    try {
      if (operation === "acquire") {
        expect((await root(directory)).rootReal).toBe(directory);
      } else if (operation === "descriptor") {
        const opened = await openRootFile({ absolutePath: filePath, rootPath: directory, boundaryLabel: "fixture" });
        expect(opened.ok).toBe(true);
        if (opened.ok) await new Promise<void>((resolve, reject) => fs.close(opened.fd, error => error ? reject(error) : resolve()));
      } else {
        if (operation === "home") vi.stubEnv("HOME", directory);
        expect(await scoped.readText(operation === "home" ? "~/value" : "value")).toBe("payload");
      }
      expect(delayed).toBe(true);
      expect(spies.map(spy => spy.mock.calls.length)).toEqual(spies.map(() => 0));
      expect(progressed).toBe(true);
    } finally {
      clearInterval(heartbeat);
    }
  },
);
