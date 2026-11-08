import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const options = { payload: () => ({ pid: process.pid }), retry: { retries: 0 } };

afterEach(() => {
  vi.restoreAllMocks();
});

function denyRemoval(lockPath: string) {
  const failure = Object.assign(new Error("sidecar deletion denied"), { code: "EACCES" });
  const realRm = fs.rmSync.bind(fs);
  const remove = vi.spyOn(fs, "rmSync").mockImplementation((target, ...args) => {
    if (String(target) === lockPath) throw failure;
    return realRm(target, ...args);
  });
  return { failure, remove };
}

describe("synchronous file-lock release retries", () => {
  it.each(["release", "reentrant release", "exit"])(
    "does not close a reused descriptor after close reports EIO (%s)",
    async (cleanupKind) => {
      const targetPath = path.join(await tempRoot("fs-safe-sync-close-reuse-"), "state.json");
      const unrelatedPath = `${targetPath}.unrelated`;
      fs.writeFileSync(unrelatedPath, "unrelated descriptor");
      const reentrant = { ...options, reentrantOwner: "operation" };
      const lock = acquireFileLockSync(targetPath, reentrant);
      const failure = Object.assign(new Error("close failed after freeing the descriptor"), { code: "EIO" });
      const realClose = fs.closeSync.bind(fs);
      let closedFd: number | undefined;
      let unrelatedFd: number | undefined;
      let unrelatedOpen = false;
      const close = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
        realClose(fd);
        // Track accidental closes so fixture cleanup cannot mask the failure.
        if (fd === unrelatedFd) unrelatedOpen = false;
        if (closedFd === undefined) {
          closedFd = fd;
          unrelatedFd = fs.openSync(unrelatedPath, "r");
          unrelatedOpen = true;
          throw failure;
        }
      });
      let nested: ReturnType<typeof acquireFileLockSync> | undefined;
      try {
        let error: unknown;
        try {
          lock.release();
        } catch (caught) {
          error = caught;
        }
        expect(error).toBe(failure);
        expect(closedFd).toBeDefined();
        expect(unrelatedFd).toBe(closedFd);
        expect(unrelatedOpen).toBe(true);
        expect(lock.verifyStillHeld()).toBe(true);

        if (cleanupKind === "reentrant release") {
          nested = acquireFileLockSync(targetPath, reentrant);
          lock.release();
          expect(nested.verifyStillHeld()).toBe(true);
          nested.release();
        } else if (cleanupKind === "exit") {
          const cleanup = Reflect.get(globalThis, Symbol.for("fsSafe.syncSidecarLockCleanupHandler")) as () => void;
          cleanup();
        }
        lock.release();
        expect(fs.existsSync(lock.lockPath)).toBe(false);
        expect(fs.readFileSync(unrelatedFd!, "utf8")).toBe("unrelated descriptor");
        expect(close.mock.calls.filter(([fd]) => fd === closedFd)).toHaveLength(1);
      } finally {
        try {
          lock.release();
          nested?.release();
        } finally {
          close.mockRestore();
          if (unrelatedOpen && unrelatedFd !== undefined) realClose(unrelatedFd);
        }
      }
    },
  );

  it("retains cleanup through repeated deletion failures and releases idempotently", async () => {
    const targetPath = path.join(await tempRoot("fs-safe-sync-release-retry-"), "state.json");
    const lock = acquireFileLockSync(targetPath, options);
    const raw = fs.readFileSync(lock.lockPath, "utf8");
    const { failure, remove } = denyRemoval(lock.lockPath);
    try {
      expect(() => lock.release()).toThrow(failure);
      expect(() => lock[Symbol.dispose]()).toThrow(failure);
      expect(remove).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(lock.lockPath, "utf8")).toBe(raw);
      expect(lock.verifyStillHeld()).toBe(true);
    } finally {
      remove.mockRestore();
      lock.release();
    }
    expect(fs.existsSync(lock.lockPath)).toBe(false);
    const next = acquireFileLockSync(targetPath, options);
    try {
      lock.release();
      lock[Symbol.dispose]();
      expect(next.verifyStillHeld()).toBe(true);
    } finally {
      next.release();
    }
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "retries after the owned parent regains write permission",
    async () => {
      const directory = await tempRoot("fs-safe-sync-release-permission-");
      const lock = acquireFileLockSync(path.join(directory, "state.json"), options);
      try {
        fs.chmodSync(directory, 0o500);
        expect(() => lock.release()).toThrow(expect.objectContaining({ code: "EACCES" }));
        expect(fs.existsSync(lock.lockPath)).toBe(true);
      } finally {
        fs.chmodSync(directory, 0o700);
        lock.release();
      }
      expect(fs.existsSync(lock.lockPath)).toBe(false);
    },
  );

  it.each(["failed handle", "new handle"])(
    "preserves reentrant references when the %s releases first after a failure",
    async (releaseFirst) => {
      const targetPath = path.join(await tempRoot("fs-safe-sync-release-refs-"), "state.json");
      const reentrant = { ...options, reentrantOwner: "operation" };
      const first = acquireFileLockSync(targetPath, reentrant);
      const second = acquireFileLockSync(targetPath, reentrant);
      first.release();
      first.release();
      const { failure, remove } = denyRemoval(second.lockPath);
      let third: ReturnType<typeof acquireFileLockSync> | undefined;
      try {
        expect(() => second.release()).toThrow(failure);
        expect(() => acquireFileLockSync(targetPath, { ...options, shouldReclaim: () => true }))
          .toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
        expect(() => acquireFileLockSync(targetPath, { ...reentrant, reentrantOwner: "other" }))
          .toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
        third = acquireFileLockSync(targetPath, reentrant);
        remove.mockRestore();
        const early = releaseFirst === "failed handle" ? second : third;
        const final = releaseFirst === "failed handle" ? third : second;
        early.release();
        early[Symbol.dispose]();
        expect(final.verifyStillHeld()).toBe(true);
        final.release();
        expect(fs.existsSync(final.lockPath)).toBe(false);
      } finally {
        remove.mockRestore();
        first.release();
        second.release();
        third?.release();
      }
    },
  );

  it.each(["rewritten payload", "new owner token"])(
    "preserves a replacement after failed release (%s)",
    async (replacementKind) => {
      const targetPath = path.join(await tempRoot("fs-safe-sync-release-replaced-"), "state.json");
      const lock = acquireFileLockSync(targetPath, options);
      const donor = acquireFileLockSync(`${targetPath}.donor`, options);
      const replacement = replacementKind === "new owner token"
        ? fs.readFileSync(donor.lockPath, "utf8")
        : "replacement";
      donor.release();
      const { failure, remove } = denyRemoval(lock.lockPath);
      try {
        expect(() => lock.release()).toThrow(failure);
        fs.unlinkSync(lock.lockPath);
        fs.writeFileSync(lock.lockPath, replacement);
      } finally {
        remove.mockRestore();
        lock.release();
      }
      lock.release();
      expect(fs.readFileSync(lock.lockPath, "utf8")).toBe(replacement);
      fs.unlinkSync(lock.lockPath);
      const next = acquireFileLockSync(targetPath, options);
      next.release();
      expect(fs.existsSync(lock.lockPath)).toBe(false);
    },
  );

  it.each([false, true])("retains exit cleanup after failed deletion (replacement=%s)", async (replace) => {
    const targetPath = path.join(await tempRoot("fs-safe-sync-release-exit-"), "state.json");
    const lock = acquireFileLockSync(targetPath, options);
    const { failure, remove } = denyRemoval(lock.lockPath);
    try {
      expect(() => lock.release()).toThrow(failure);
      if (replace) fs.writeFileSync(lock.lockPath, "replacement");
    } finally {
      remove.mockRestore();
    }
    fs.writeFileSync(`${targetPath}.unrelated`, "unrelated descriptor");
    const unrelated = fs.openSync(`${targetPath}.unrelated`, "r");
    const cleanup = Reflect.get(globalThis, Symbol.for("fsSafe.syncSidecarLockCleanupHandler")) as () => void;
    try {
      cleanup();
      lock.release();
      expect(fs.readFileSync(unrelated, "utf8")).toBe("unrelated descriptor");
    } finally {
      fs.closeSync(unrelated);
    }
    if (replace) expect(fs.readFileSync(lock.lockPath, "utf8")).toBe("replacement");
    else expect(fs.existsSync(lock.lockPath)).toBe(false);
  });
});
