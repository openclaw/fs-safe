import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import * as timing from "../src/timing.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  configureFsSafeNative({ mode: "auto" });
});

for (const kind of ["raw-async", "raw-sync", "root-async", "root-sync"] as const) {
  it.each(["once", "persistent", "foreign-path"])(`${kind} keeps staging-open denial provenance (%s)`, async scenario => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-stage-denial-");
    const target = path.join(directory, "state");
    const lockRoot = kind.startsWith("root") ? await root(directory) : undefined;
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.spyOn(timing, "sleep").mockResolvedValue();
    vi.spyOn(timing, "sleepSync").mockImplementation(() => {});
    const failure = Object.assign(new Error("stage open denied"), { code: "EPERM", path: "" });
    let attempts = 0;
    const deny = (candidate: unknown) => {
      if (typeof candidate !== "string" || !path.basename(candidate).startsWith(".fs-safe-lock-")) return;
      attempts++;
      if (scenario === "once" && attempts > 1) return;
      failure.path = scenario === "foreign-path" ? directory : candidate;
      throw failure;
    };
    const open = fsp.open, openSync = fs.openSync;
    vi.spyOn(fsp, "open").mockImplementation(async (...args) => { deny(args[0]); return await Reflect.apply(open, fsp, args); });
    vi.spyOn(fs, "openSync").mockImplementation((...args) => { deny(args[0]); return Reflect.apply(openSync, fs, args); });
    const options = { lockRoot, payload: () => ({ owner: "creator" }), timeoutMs: Infinity, retry: { retries: 20, minTimeout: 0, maxTimeout: 0 } };
    const acquire = async () => kind.endsWith("async") ? await acquireFileLock(target, options) : acquireFileLockSync(target, options);
    if (scenario === "once") {
      const owner = await acquire();
      try { expect(await owner.verifyStillHeld()).toBe(true); }
      finally { await owner.release(); }
      expect(attempts).toBe(2);
    } else {
      await expect(acquire()).rejects.toBe(failure);
      expect(attempts).toBe(scenario === "persistent" ? 9 : 1);
    }
    expect(await fsp.readdir(directory)).toEqual([]);
  });
}
