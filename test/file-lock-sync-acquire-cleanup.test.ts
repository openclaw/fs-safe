import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const options = { payload: () => ({ owner: "test" }), timeoutMs: 0, retry: { retries: 0 } };
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });

describe("synchronous file-lock acquisition cleanup", () => {
  it.each(["writeFileSync", "fsyncSync", "fstatSync"] as const)(
    "closes the stage exactly once after %s fails, without creating a final lock", async operation => {
      const directory = await tempRoot("fs-safe-sync-lock-cleanup-stat-");
      const target = path.join(directory, "state.json");
      const failure = Object.assign(new Error(`${operation} failed`), { code: "EIO" });
      const realStat = fs.fstatSync.bind(fs);
      const open = vi.spyOn(fs, "openSync");
      const close = vi.spyOn(fs, "closeSync");
      vi.spyOn(fs, operation).mockImplementationOnce(() => { throw failure; });
      expect(() => acquireFileLockSync(target, options)).toThrow(failure);
      const fd = open.mock.results[0]?.value as number;
      expect(close).toHaveBeenCalledExactlyOnceWith(fd);
      expect(() => realStat(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(fs.existsSync(`${target}.lock`)).toBe(false);
      // Without the first identity observation the stage cannot be deleted safely.
      expect(fs.readdirSync(directory)).toHaveLength(operation === "fstatSync" ? 1 : 0);
    },
  );

  it.each(["close", "remove"])("retains the acquisition and cleanup %s failures", async operation => {
    const directory = await tempRoot("fs-safe-sync-lock-cleanup-error-");
    const target = path.join(directory, "state.json");
    const acquisitionError = Object.assign(new Error("payload persistence failed"), { code: "EIO" });
    const cleanupError = Object.assign(new Error(`${operation} failed`), { code: "EACCES" });
    const realClose = fs.closeSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw acquisitionError; });
    if (operation === "close") vi.spyOn(fs, "closeSync").mockImplementationOnce(fd => { realClose(fd); throw cleanupError; });
    else vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw cleanupError; });
    let caught: unknown;
    try { acquireFileLockSync(target, options); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ name: "SuppressedError", error: acquisitionError, suppressed: cleanupError });
    expect(fs.existsSync(`${target}.lock`)).toBe(false);
    expect(fs.readdirSync(directory)).toHaveLength(operation === "close" ? 0 : 1);
  });
});
