import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const immediate = { timeoutMs: 0, retry: { retries: 0 } } as const;

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
    fs.mkdirSync(original);
    let lock: ReturnType<typeof acquireFileLockSync> | undefined;
    try {
      const lockRoot = await root(original);
      const rootLock = acquireFileLockSync(path.join(original, "state.json"), {
        lockRoot,
        payload: () => ({ owner: "test" }),
      });
      lock = rootLock;
      const rootBytes = fs.readFileSync(rootLock.lockPath);
      const rootIdentity = fs.lstatSync(rootLock.lockPath, { bigint: true });
      const cleanup = Reflect.get(
        globalThis,
        Symbol.for("fsSafe.syncSidecarLockCleanupHandler"),
      ) as () => void;
      cleanup();
      expect(fs.existsSync(rawLock.lockPath)).toBe(false);
      expect(fs.readFileSync(rootLock.lockPath)).toEqual(rootBytes);
      const currentIdentity = fs.lstatSync(rootLock.lockPath, { bigint: true });
      expect([currentIdentity.dev, currentIdentity.ino])
        .toEqual([rootIdentity.dev, rootIdentity.ino]);
      expect(rootLock.verifyStillHeld()).toBe(true);
    } finally {
      try {
        rawLock.release();
      } finally {
        lock?.release();
      }
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
            ...immediate,
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
    const replacementLockPath = path.join(original, "state.json.lock");
    const movedLockPath = path.join(moved, "state.json.lock");
    fs.mkdirSync(original);
    let armed = false;
    let originalMoved = false;
    let replacementRootCreated = false;
    let replacementWritten = false;
    let mutationAssertions = 0;
    let raw: Buffer | undefined;
    const lockRoot = await root(original, {
      assertBeforeMutation: () => {
        if (!armed || originalMoved) return;
        // Exit cleanup consumes the owned descriptor before reaching this
        // retained-authority callback, so the physical swap works on Windows.
        mutationAssertions += 1;
        fs.renameSync(original, moved);
        originalMoved = true;
        fs.mkdirSync(original);
        replacementRootCreated = true;
        if (raw === undefined) throw new Error("exit-cleanup fixture bytes are unavailable");
        fs.writeFileSync(replacementLockPath, raw, { flag: "wx" });
        replacementWritten = true;
      },
    });
    const lock = acquireFileLockSync(path.join(original, "state.json"), {
      lockRoot,
      payload: () => ({ owner: "test" }),
    });
    try {
      raw = fs.readFileSync(lock.lockPath);
      const ownedIdentity = fs.lstatSync(lock.lockPath, { bigint: true });
      const cleanup = Reflect.get(
        globalThis,
        Symbol.for("fsSafe.syncRootSidecarLockCleanupHandler.v1"),
      ) as () => void;
      armed = true;
      cleanup();
      expect(mutationAssertions).toBe(1);
      expect(originalMoved && replacementRootCreated && replacementWritten).toBe(true);
      expect(fs.readFileSync(replacementLockPath)).toEqual(raw);
      expect(fs.readFileSync(movedLockPath)).toEqual(raw);
      const replacementIdentity = fs.lstatSync(replacementLockPath, { bigint: true });
      const movedIdentity = fs.lstatSync(movedLockPath, { bigint: true });
      expect([movedIdentity.dev, movedIdentity.ino])
        .toEqual([ownedIdentity.dev, ownedIdentity.ino]);
      expect([replacementIdentity.dev, replacementIdentity.ino])
        .not.toEqual([ownedIdentity.dev, ownedIdentity.ino]);
    } finally {
      armed = false;
      if (replacementRootCreated && fs.existsSync(original)) {
        fs.rmSync(original, { recursive: true, force: true });
      }
      if (originalMoved && fs.existsSync(moved) && !fs.existsSync(original)) {
        fs.renameSync(moved, original);
      }
      try {
        lock.release();
      } finally {
        if (fs.existsSync(path.join(original, "state.json.lock"))) {
          fs.unlinkSync(path.join(original, "state.json.lock"));
        }
      }
    }
  });
});
