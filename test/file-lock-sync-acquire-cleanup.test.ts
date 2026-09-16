import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const options = { payload: () => ({ owner: "test" }), timeoutMs: 0, retry: { retries: 0 } };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("synchronous file-lock acquisition cleanup", () => {
  it.each(["writeFileSync", "fsyncSync", "fstatSync"] as const)(
    "closes once and preserves the original %s failure when cleanup stat fails",
    async (operation) => {
      const target = path.join(await tempRoot("fs-safe-sync-lock-cleanup-stat-"), "state.json");
      const lockPath = `${target}.lock`;
      const acquisitionError = Object.assign(new Error(`${operation} failed`), { code: "EIO" });
      const statError = Object.assign(new Error("cleanup stat failed"), { code: "EACCES" });
      const realStat = fs.fstatSync.bind(fs);
      const realClose = fs.closeSync.bind(fs);
      const open = vi.spyOn(fs, "openSync");
      const close = vi.spyOn(fs, "closeSync");
      const remove = vi.spyOn(fs, "rmSync");
      const unlink = vi.spyOn(fs, "unlinkSync");
      const stat = vi.spyOn(fs, "fstatSync").mockImplementation(() => { throw statError; });
      if (operation === "fstatSync") {
        stat.mockImplementationOnce(() => { throw acquisitionError; });
      } else {
        vi.spyOn(fs, operation).mockImplementationOnce(() => { throw acquisitionError; });
      }

      let acquiredFd: number | undefined;
      try {
        let error: unknown;
        try {
          acquireFileLockSync(target, options);
        } catch (caught) {
          error = caught;
        }
        acquiredFd = open.mock.results[0]?.value as number | undefined;
        expect(error).toBe(acquisitionError);
        expect(stat).toHaveBeenCalledTimes(operation === "fstatSync" ? 2 : 1);
        expect(open).toHaveBeenCalledTimes(1);
        expect(acquiredFd).toBeTypeOf("number");
        expect(close).toHaveBeenCalledExactlyOnceWith(acquiredFd);
        expect(remove).not.toHaveBeenCalled();
        expect(unlink).not.toHaveBeenCalled();
        expect(() => realStat(acquiredFd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
        expect(fs.existsSync(lockPath)).toBe(true);
        if (operation !== "writeFileSync") {
          expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual({ owner: "test" });
        }
      } finally {
        // Keep a regression against the old leaking implementation from leaking in the test runner.
        const closeAttempted = close.mock.calls.some(([fd]) => fd === acquiredFd);
        vi.restoreAllMocks();
        if (acquiredFd !== undefined && !closeAttempted) {
          realClose(acquiredFd);
        }
      }
    },
  );

  it.each(["close", "remove"])(
    "keeps the acquisition failure primary when cleanup %s fails",
    async (operation) => {
      const target = path.join(await tempRoot("fs-safe-sync-lock-cleanup-error-"), "state.json");
      const lockPath = `${target}.lock`;
      const acquisitionError = Object.assign(new Error("payload persistence failed"), { code: "EIO" });
      const cleanupError = Object.assign(new Error(`${operation} failed`), { code: "EACCES" });
      const realClose = fs.closeSync.bind(fs);
      const realStat = fs.fstatSync.bind(fs);
      vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw acquisitionError; });
      const open = vi.spyOn(fs, "openSync");
      const close = vi.spyOn(fs, "closeSync");
      const remove = vi.spyOn(fs, "rmSync");
      if (operation === "close") {
        close.mockImplementationOnce((fd) => {
          realClose(fd);
          throw cleanupError;
        });
      } else {
        remove.mockImplementationOnce(() => { throw cleanupError; });
      }

      let error: unknown;
      try {
        acquireFileLockSync(target, options);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ name: "SuppressedError", error: acquisitionError, suppressed: cleanupError });
      expect((error as { error: unknown }).error).toBe(acquisitionError);
      expect((error as { suppressed: unknown }).suppressed).toBe(cleanupError);
      const acquiredFd = open.mock.results[0]?.value as number;
      expect(close.mock.calls[0]).toEqual([acquiredFd]);
      expect(() => realStat(acquiredFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(fs.existsSync(lockPath)).toBe(true);
      if (operation === "close") {
        expect(close).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledTimes(1);
        expect(remove).not.toHaveBeenCalled();
      } else {
        // Removal verification opens and closes its own descriptor after the acquisition fd closes.
        expect(close).toHaveBeenCalledTimes(2);
        expect(open).toHaveBeenCalledTimes(2);
        expect(remove).toHaveBeenCalledExactlyOnceWith(lockPath);
      }
    },
  );
});
