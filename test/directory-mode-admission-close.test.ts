import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { createSecretFileAtomic, writeSecretFileAtomic } from "../src/secret.js";
import { tempWorkspaceSync } from "../src/temp.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

type Failure = "swap" | "inspection" | "close-only";
const failures: Failure[] = ["swap", "inspection", "close-only"];

function injectedFailures() {
  const inspectionCause = new Error("synthetic metadata cause");
  const inspection = Object.assign(new Error("directory inspection failed", { cause: inspectionCause }), { code: "EIO" });
  const closeCause = new Error("synthetic close cause");
  const close = Object.assign(new Error("directory close failed", { cause: closeCause }), { code: "EBADF" });
  return { inspection, inspectionCause, close, closeCause };
}

function expectFailure(error: unknown, kind: Failure, failures: ReturnType<typeof injectedFailures>): void {
  if (kind === "swap") {
    expect(error).toMatchObject({ code: "path-mismatch", category: "policy" });
    expect(error).not.toBe(failures.close);
  } else {
    expect(error).toBe(kind === "inspection" ? failures.inspection : failures.close);
    expect(error).toMatchObject({
      code: kind === "inspection" ? "EIO" : "EBADF",
      cause: kind === "inspection" ? failures.inspectionCause : failures.closeCause,
    });
  }
}

describe.skipIf(process.platform === "win32")("initial directory-mode admission cleanup", () => {
  describe.each([
    { name: "writeSecretFileAtomic", write: writeSecretFileAtomic },
    { name: "createSecretFileAtomic", write: createSecretFileAtomic },
  ])("$name", ({ write }) => {
    it.each(failures)("preserves the selected %s failure and closes once", async kind => {
      const rootDir = await tempRoot("fs-safe-directory-admission-close-");
      await fs.chmod(rootDir, 0o700);
      const parent = path.join(rootDir, "parent"), moved = path.join(rootDir, "moved");
      const filePath = path.join(parent, "token");
      const failures = injectedFailures();
      const open = fs.open.bind(fs);
      const fstat = fsSync.fstatSync.bind(fsSync);
      let descriptor: number | undefined, closes = 0, injected = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) !== parent) return handle;
        expect(descriptor).toBeUndefined();
        descriptor = handle.fd;
        const close = handle.close.bind(handle);
        handle.close = async () => { closes++; await close(); throw failures.close; };
        if (kind === "swap") {
          await fs.rename(parent, moved);
          await fs.mkdir(parent, { mode: 0o750 });
          await fs.chmod(parent, 0o750);
          injected = true;
        }
        return handle;
      });
      vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
        if (kind === "inspection" && args[0] === descriptor && !injected) {
          injected = true;
          throw failures.inspection;
        }
        return fstat(...args);
      });
      const chmod = vi.spyOn(fs, "chmod");
      let caught = false, error: unknown;
      try { await write({ rootDir, filePath, content: "synthetic secret" }); }
      catch (failure) { caught = true; error = failure; }

      expect(caught).toBe(true);
      expectFailure(error, kind, failures);
      expect(closes).toBe(1);
      expect(descriptor).toBeDefined();
      expect(() => fstat(descriptor!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
      expect(injected).toBe(kind !== "close-only");
      expect(chmod).toHaveBeenCalledTimes(kind === "swap" ? 1 : 0);
      await expect(fs.lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(parent)).toEqual([]);
      expect((await fs.lstat(parent)).mode & 0o7777).toBe(kind === "swap" ? 0o750 : 0o700);
      if (kind === "swap") {
        expect(await fs.readdir(moved)).toEqual([]);
        expect((await fs.lstat(moved)).mode & 0o7777).toBe(0o700);
      }
    });
  });

  it.each(failures)("tempWorkspaceSync preserves the selected %s root-admission failure", async kind => {
    const sandbox = await tempRoot("fs-safe-sync-directory-admission-close-");
    const rootDir = path.join(sandbox, "root"), moved = path.join(sandbox, "moved");
    const failures = injectedFailures();
    const open = fsSync.openSync.bind(fsSync);
    const close = fsSync.closeSync.bind(fsSync);
    const fstat = fsSync.fstatSync.bind(fsSync);
    const fixtureFchmod = fsSync.fchmodSync.bind(fsSync);
    let descriptor: number | undefined, closes = 0, injected = false;
    let swapSetupFailure: { error: unknown } | undefined;
    vi.spyOn(fsSync, "openSync").mockImplementation((...args) => {
      const selected = String(args[0]) === rootDir;
      if (selected) expect(descriptor).toBeUndefined();
      const fd = open(...args);
      if (selected) descriptor = fd;
      return fd;
    });
    vi.spyOn(fsSync, "closeSync").mockImplementation(fd => {
      if (fd === descriptor) closes++;
      close(fd);
      if (fd === descriptor) throw failures.close;
    });
    vi.spyOn(fsSync, "fstatSync").mockImplementation((...args) => {
      if (kind === "inspection" && args[0] === descriptor && !injected) {
        injected = true;
        throw failures.inspection;
      }
      const observed = fstat(...args);
      if (kind === "swap" && args[0] === descriptor && !injected) {
        try {
          // The helper owns this fd now. Grant owner-write for the macOS 15 rename.
          const originalMode = Number(observed.mode) & 0o7777;
          expect(originalMode).toBe(0o500);
          fixtureFchmod(descriptor, originalMode | 0o200);
          try { fsSync.renameSync(rootDir, moved); }
          finally { fixtureFchmod(descriptor, originalMode); }
          fsSync.mkdirSync(rootDir, { mode: 0o750 });
          fsSync.chmodSync(rootDir, 0o750);
          injected = true;
        } catch (error) {
          swapSetupFailure = { error };
          throw error;
        }
      }
      return observed;
    });
    const chmod = vi.spyOn(fsSync, "fchmodSync");
    let caught = false, error: unknown;
    // The missing root is created at 0500, requiring mode initialization through
    // this helper before any ordinary workspace child is created or adopted.
    const previous = process.umask(0o200);
    try { tempWorkspaceSync({ rootDir, prefix: "admission-" }); }
    catch (failure) { caught = true; error = failure; }
    finally { process.umask(previous); }
    try {
      expect(caught).toBe(true);
      expect(closes).toBe(1);
      expect(descriptor).toBeDefined();
      expect(() => fstat(descriptor!)).toThrowError(expect.objectContaining({ code: "EBADF" }));
      if (swapSetupFailure) throw swapSetupFailure.error;
      expectFailure(error, kind, failures);
      expect(injected).toBe(kind !== "close-only");
      expect(chmod).toHaveBeenCalledTimes(kind === "close-only" ? 1 : 0);
      expect(fsSync.readdirSync(rootDir)).toEqual([]);
      expect(fsSync.lstatSync(rootDir).mode & 0o7777).toBe(kind === "swap" ? 0o750 : kind === "inspection" ? 0o500 : 0o700);
      if (kind === "swap") expect(fsSync.lstatSync(moved).mode & 0o7777).toBe(0o500);
    } finally {
      for (const directory of kind === "swap" ? [rootDir, moved] : [rootDir]) {
        try { fsSync.chmodSync(directory, 0o700); }
        catch (error) {
          // Either name may be absent after failed setup; retain that diagnostic.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  });
});
