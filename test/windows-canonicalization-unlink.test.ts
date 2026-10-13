import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileObservation } from "../src/file-observation.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  configureFsSafeNative({ mode: "auto" });
});

describe.runIf(process.platform === "win32")("Windows canonicalization during unlink", () => {
  it.each(["off", "auto"] as const)("retains the descriptor-backed unlink receipt in %s", async (mode) => {
    configureFsSafeNative({ mode });
    const capability = await root(await tempRoot("fs-safe-realpath-unlink-"));
    const target = path.join(capability.rootReal, "target");
    fs.writeFileSync(target, "original");
    const nativeRealpath = fs.realpathSync.native;
    let nativeDenial: NodeJS.ErrnoException | undefined;
    let armed = false;
    let unlinked = false;
    __setFsSafeTestHooksForTest({
      beforeRootReadFinalFence(candidate) {
        if (candidate === target) armed = true;
      },
    });
    // Schedule a real unlink after the final pathname identity observation and
    // before the real OS canonicalization, while Root still owns the descriptor.
    vi.spyOn(fs.realpathSync, "native").mockImplementation((...args) => {
      if (armed && !unlinked && String(args[0]) === target) {
        unlinked = true;
        fs.unlinkSync(target);
        try { return nativeRealpath(...args); }
        catch (error) { nativeDenial = error as NodeJS.ErrnoException; throw error; }
      }
      return nativeRealpath(...args);
    });
    const observation = fileObservation();
    const error = await observation.run(() => capability.open("target"))
      .then(async (opened) => { await opened.handle.close(); return undefined; }, (error: unknown) => error);
    expect(unlinked).toBe(true);
    expect(nativeDenial).toMatchObject({ code: "EPERM", syscall: "realpath" });
    expect(error).toMatchObject({ name: "FsSafeError", code: mode === "off" ? "helper-unavailable" : expect.any(String) });
    expect(observation.has(error, `unlinked:${target}`)).toBe(true);
    expect(() => fs.lstatSync(target)).toThrowError(expect.objectContaining({ code: "ENOENT" }));
  });
});
