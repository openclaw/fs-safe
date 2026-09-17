import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("synchronous Root-backed file-lock exit lifecycle", () => {
  it("keeps Root-owned records invisible to the legacy raw cleanup symbols", async () => {
    const directory = await tempRoot("fs-safe-sync-root-exit-");
    const rawLock = acquireFileLockSync(path.join(directory, "legacy.json"), {
      payload: () => ({ owner: "legacy" }),
    });
    const original = path.join(directory, "root");
    const moved = path.join(directory, "moved");
    fs.mkdirSync(original);
    const lockRoot = await root(original);
    const lock = acquireFileLockSync(path.join(original, "state.json"), {
      lockRoot,
      payload: () => ({ owner: "test" }),
    });
    const raw = fs.readFileSync(lock.lockPath, "utf8");
    let movedRoot = false;
    try {
      fs.renameSync(original, moved);
      movedRoot = true;
      fs.mkdirSync(original);
      fs.writeFileSync(path.join(original, "state.json.lock"), raw);
      const cleanup = Reflect.get(
        globalThis,
        Symbol.for("fsSafe.syncSidecarLockCleanupHandler"),
      ) as () => void;
      cleanup();
      expect(fs.existsSync(rawLock.lockPath)).toBe(false);
      expect(fs.readFileSync(path.join(original, "state.json.lock"), "utf8")).toBe(raw);
      expect(fs.existsSync(path.join(moved, "state.json.lock"))).toBe(true);
    } finally {
      rawLock.release();
      if (movedRoot) {
        fs.rmSync(original, { recursive: true, force: true });
        fs.renameSync(moved, original);
      }
      lock.release();
    }
  });

  it("consumes descriptor ownership before recursively entered exit cleanup", async () => {
    const directory = await tempRoot("fs-safe-sync-root-exit-close-reentry-");
    const lockRoot = await root(directory);
    const lock = acquireFileLockSync(path.join(directory, "state.json"), {
      lockRoot,
      payload: () => ({ owner: "test" }),
    });
    const cleanup = Reflect.get(
      globalThis,
      Symbol.for("fsSafe.syncRootSidecarLockCleanupHandler.v1"),
    ) as () => void;
    const actualClose = fs.closeSync;
    let recursivelyEntered = false;
    const close = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      actualClose(fd);
      if (recursivelyEntered) return;
      recursivelyEntered = true;
      cleanup();
    });
    cleanup();
    expect(recursivelyEntered).toBe(true);
    // One retained ownership descriptor and one fresh verification descriptor.
    // Recursive cleanup must not attempt to close the retained descriptor again.
    expect(close).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(lock.lockPath)).toBe(false);
    lock.release();
  });

  it("does not let reentrant exit cleanup delete a refreshed held entry", async () => {
    const directory = await tempRoot("fs-safe-sync-root-exit-entry-reentry-");
    const target = path.join(directory, "state.json");
    const owner = "same-owner";
    const events: string[] = [];
    let armed = false;
    let inCallback = false;
    let cleanup: (() => void) | undefined;
    let successor: ReturnType<typeof acquireFileLockSync> | undefined;
    const successorPayload = vi.fn(() => ({ owner: "successor" }));
    const lockRoot = await root(directory, {
      assertBeforeMutation: () => {
        if (!armed || inCallback) return;
        inCallback = true;
        events.push("cleanup-callback:start");
        try {
          cleanup!();
          successor = acquireFileLockSync(target, {
            lockRoot,
            payload: successorPayload,
            reentrantOwner: owner,
          });
        } finally {
          events.push("cleanup-callback:end");
          inCallback = false;
        }
      },
    });
    const original = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "original" }),
      reentrantOwner: owner,
    });
    cleanup = Reflect.get(
      globalThis,
      Symbol.for("fsSafe.syncRootSidecarLockCleanupHandler.v1"),
    ) as () => void;
    armed = true;
    try {
      cleanup();
      expect(events).toEqual(["cleanup-callback:start", "cleanup-callback:end"]);
      expect(successorPayload).not.toHaveBeenCalled();
      expect(successor).toBeDefined();
      expect(successor!.verifyStillHeld()).toBe(true);
      expect(fs.existsSync(original.lockPath)).toBe(true);
      successor!.release();
      expect(fs.existsSync(original.lockPath)).toBe(true);
      armed = false;
      original.release();
      expect(fs.existsSync(original.lockPath)).toBe(false);
    } finally {
      armed = false;
      successor?.release();
      original.release();
      if (fs.existsSync(original.lockPath)) fs.unlinkSync(original.lockPath);
    }
  });

  it("leaves ambiguous paths in place during Root exit cleanup", async () => {
    const directory = await tempRoot("fs-safe-sync-root-exit-authority-");
    const original = path.join(directory, "root");
    const moved = path.join(directory, "moved");
    fs.mkdirSync(original);
    const lockRoot = await root(original);
    const lock = acquireFileLockSync(path.join(original, "state.json"), {
      lockRoot,
      payload: () => ({ owner: "test" }),
    });
    const raw = fs.readFileSync(lock.lockPath, "utf8");
    fs.renameSync(original, moved);
    fs.mkdirSync(original);
    fs.writeFileSync(path.join(original, "state.json.lock"), raw);
    const cleanup = Reflect.get(
      globalThis,
      Symbol.for("fsSafe.syncRootSidecarLockCleanupHandler.v1"),
    ) as () => void;
    try {
      cleanup();
      expect(fs.readFileSync(path.join(original, "state.json.lock"), "utf8")).toBe(raw);
      expect(fs.readFileSync(path.join(moved, "state.json.lock"), "utf8")).toBe(raw);
    } finally {
      fs.rmSync(original, { recursive: true, force: true });
      fs.renameSync(moved, original);
      fs.unlinkSync(path.join(original, "state.json.lock"));
      lock.release();
    }
  });
});
