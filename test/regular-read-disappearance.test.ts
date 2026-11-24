import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { readRegularFile, readRegularFileSync } from "../src/regular-file.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => vi.restoreAllMocks());

async function captureReadFailure(read: () => unknown): Promise<FsSafeError> {
  try {
    await read();
  } catch (error) {
    expect(error).toBeInstanceOf(FsSafeError);
    return error as FsSafeError;
  }
  throw new Error("Expected regular read to fail");
}

describe("regular read disappearance causes", () => {
  for (const kind of ["async", "sync"] as const) {
    it.each(["ENOENT", "ENOTDIR"].flatMap((code) =>
      ["before-open", "after-open"].map((phase) => ({ code, phase })),
    ))(`${kind} preserves $code from $phase as the mismatch cause`, async ({ code, phase }) => {
      const root = await tempRoot("fs-safe-regular-vanish-");
      const filePath = path.join(root, "value");
      await fs.writeFile(filePath, "abc");
      const missing = Object.assign(new Error("vanished"), { code });
      if (phase === "before-open") {
        if (kind === "async") vi.spyOn(fs, "open").mockRejectedValueOnce(missing);
        else vi.spyOn(fsSync, "openSync").mockImplementationOnce(() => { throw missing; });
      } else {
        const lstat = fsSync.lstatSync.bind(fsSync);
        let calls = 0;
        vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
          if (String(args[0]) === filePath && ++calls === 2) throw missing;
          return lstat(...args);
        });
      }
      const error = await captureReadFailure(() => kind === "async"
        ? readRegularFile({ filePath }) : readRegularFileSync({ filePath }));
      expect(error).toMatchObject({
        code: "path-mismatch", category: "policy",
        message: `File changed during read: ${filePath}`,
      });
      expect(error.cause).toBe(missing);
    });
  }

  it("retains real unlink failure and closes the unread async descriptor", async () => {
    const filePath = path.join(await tempRoot("fs-safe-regular-unlink-"), "value");
    await fs.writeFile(filePath, "abc");
    const open = fs.open.bind(fs);
    let handle: fs.FileHandle | undefined;
    let openedFd = -1;
    let read: { mock: { calls: unknown[] } } | undefined;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      handle = await open(...args);
      try {
        openedFd = handle.fd;
        read = vi.spyOn(handle, "read");
        await fs.unlink(filePath);
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    });
    try {
      const error = await captureReadFailure(() => readRegularFile({ filePath }));
      expect(error.code).toBe("path-mismatch");
      expect(error.cause).toMatchObject({ code: "ENOENT", syscall: "lstat", path: filePath });
      expect(read?.mock.calls).toEqual([]);
      expect(openedFd).toBeGreaterThanOrEqual(0);
      expect(() => fsSync.fstatSync(openedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    } finally {
      await handle?.close();
    }
  });

  it("retains real unlink failure and closes the unread sync descriptor", async () => {
    const filePath = path.join(await tempRoot("fs-safe-regular-sync-unlink-"), "value");
    await fs.writeFile(filePath, "abc");
    const open = fsSync.openSync.bind(fsSync);
    let openedFd = -1;
    vi.spyOn(fsSync, "openSync").mockImplementationOnce((...args) => {
      openedFd = open(...args);
      try {
        fsSync.unlinkSync(filePath);
        return openedFd;
      } catch (error) {
        fsSync.closeSync(openedFd);
        throw error;
      }
    });
    const read = vi.spyOn(fsSync, "readFileSync");
    try {
      const error = await captureReadFailure(() => readRegularFileSync({ filePath }));
      expect(error.code).toBe("path-mismatch");
      expect(error.cause).toMatchObject({ code: "ENOENT", syscall: "lstat", path: filePath });
      expect(read).not.toHaveBeenCalled();
      expect(openedFd).toBeGreaterThanOrEqual(0);
      expect(() => fsSync.fstatSync(openedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    } finally {
      if (openedFd >= 0) {
        try { fsSync.closeSync(openedFd); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error; }
      }
    }
  });
});
