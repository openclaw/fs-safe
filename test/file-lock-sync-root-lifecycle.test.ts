import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFileLockSync,
  withFileLockSync,
  type FileLockSyncAcquireOptions,
} from "../src/file-lock.js";
import { root } from "../src/root.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const immediate = { timeoutMs: 0, retry: { retries: 0 } } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("synchronous Root-backed file-lock lifecycle", () => {
  it("rejects multiply-linked sidecars under the Root read default", async () => {
    const directory = await tempRoot("fs-safe-sync-root-hardlink-");
    const lockPath = path.join(directory, "state.lock");
    fs.writeFileSync(lockPath, "{}");
    fs.linkSync(lockPath, path.join(directory, "alias.lock"));
    const lockRoot = await root(directory);
    const shouldReclaim = vi.fn(() => true);
    expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
      ...immediate,
      lockPath,
      lockRoot,
      payload: () => ({ owner: "test" }),
      shouldReclaim,
    })).toThrow(expect.objectContaining({ code: "hardlink" }));
    expect(shouldReclaim).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, "utf8")).toBe("{}");
  });

  it("preserves primary reclaim failure and suppressed guard-cleanup failure", async () => {
    const directory = await tempRoot("fs-safe-sync-root-reclaim-race-");
    const original = path.join(directory, "root");
    const moved = path.join(directory, "moved");
    fs.mkdirSync(original);
    const lockPath = path.join(original, "state.lock");
    fs.writeFileSync(lockPath, "{}");
    const lockRoot = await root(original);
    let swapped = false;
    let failure: unknown;
    try {
      acquireFileLockSync(path.join(original, "state.json"), {
        ...immediate,
        lockPath,
        lockRoot,
        payload: () => ({ owner: "new" }),
        shouldReclaim: () => true,
        staleRecovery: "remove-if-unchanged",
        shouldRemoveStaleLock: () => {
          fs.renameSync(original, moved);
          fs.mkdirSync(original);
          fs.writeFileSync(path.join(original, "state.lock"), "replacement");
          swapped = true;
          return true;
        },
      });
    } catch (error) {
      failure = error;
    }
    try {
      expect(swapped).toBe(true);
      expect(failure).toMatchObject({
        name: "SuppressedError",
        error: expect.objectContaining({ code: "path-mismatch" }),
        suppressed: expect.objectContaining({ code: "path-mismatch" }),
      });
      expect(fs.readFileSync(path.join(original, "state.lock"), "utf8")).toBe("replacement");
      expect(fs.readFileSync(path.join(moved, "state.lock"), "utf8")).toBe("{}");
      expect(fs.statSync(path.join(moved, "state.lock.reclaim")).isDirectory()).toBe(true);
    } finally {
      if (swapped) {
        fs.rmSync(original, { recursive: true, force: true });
        fs.renameSync(moved, original);
        fs.rmdirSync(path.join(original, "state.lock.reclaim"));
        fs.unlinkSync(path.join(original, "state.lock"));
      }
    }
  });

  it("preserves snapshot-read and descriptor-close failures together", async () => {
    const directory = await tempRoot("fs-safe-sync-root-read-close-");
    const lockPath = path.join(directory, "state.lock");
    fs.writeFileSync(lockPath, "{}");
    const lockRoot = await root(directory);
    const readFailure = new Error("snapshot read failed");
    const closeFailure = new Error("snapshot close failed");
    const actualClose = fs.closeSync;
    vi.spyOn(fs, "readSync").mockImplementation(() => { throw readFailure; });
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      actualClose(fd);
      throw closeFailure;
    });
    let failure: unknown;
    try {
      acquireFileLockSync(path.join(directory, "state.json"), {
        ...immediate,
        lockPath,
        lockRoot,
        payload: () => ({ owner: "test" }),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ name: "SuppressedError" });
    expect((failure as { error: unknown }).error).toBe(closeFailure);
    expect((failure as { suppressed: unknown }).suppressed).toBe(readFailure);
  });

  it("preserves protected callback and Root release failures together", async () => {
    const directory = await tempRoot("fs-safe-sync-root-with-release-");
    const original = path.join(directory, "root");
    const moved = path.join(directory, "moved");
    fs.mkdirSync(original);
    const lockRoot = await root(original);
    const callbackFailure = new Error("protected callback failed");
    let failure: unknown;
    try {
      withFileLockSync(path.join(original, "state.json"), {
        lockRoot,
        payload: () => ({ owner: "test" }),
      }, () => {
        fs.renameSync(original, moved);
        fs.mkdirSync(original);
        throw callbackFailure;
      });
    } catch (error) {
      failure = error;
    }
    try {
      expect(failure).toMatchObject({
        name: "SuppressedError",
        error: expect.objectContaining({ code: "path-mismatch" }),
      });
      expect((failure as { suppressed: unknown }).suppressed).toBe(callbackFailure);
      expect(fs.existsSync(path.join(moved, "state.json.lock"))).toBe(true);
    } finally {
      fs.rmdirSync(original);
      fs.renameSync(moved, original);
      const cleanup = Reflect.get(
        globalThis,
        Symbol.for("fsSafe.syncRootSidecarLockCleanupHandler.v1"),
      ) as () => void;
      cleanup();
    }
    expect(fs.existsSync(path.join(original, "state.json.lock"))).toBe(false);
  });

  it("preserves a same-owner handle acquired by the final release callback", async () => {
    const directory = await tempRoot("fs-safe-sync-root-release-reentry-");
    const target = path.join(directory, "state.json");
    const owner = "same-owner";
    const events: string[] = [];
    let armed = false;
    let reentering = false;
    let inner: ReturnType<typeof acquireFileLockSync> | undefined;
    const innerPayload = vi.fn(() => ({ owner: "inner" }));
    const lockRoot = await root(directory, {
      assertBeforeMutation: () => {
        if (!armed || reentering || inner) return;
        reentering = true;
        events.push("release-callback:start");
        try {
          inner = acquireFileLockSync(target, {
            lockRoot,
            payload: innerPayload,
            reentrantOwner: owner,
          });
        } finally {
          events.push("release-callback:end");
          reentering = false;
        }
      },
    });
    const outer = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "outer" }),
      reentrantOwner: owner,
    });
    armed = true;
    outer.release();
    expect(events).toEqual(["release-callback:start", "release-callback:end"]);
    expect(innerPayload).not.toHaveBeenCalled();
    expect(inner).toBeDefined();
    expect(inner!.verifyStillHeld()).toBe(true);
    expect(fs.existsSync(outer.lockPath)).toBe(true);

    const thirdPayload = vi.fn(() => ({ owner: "third" }));
    const third = acquireFileLockSync(target, {
      lockRoot,
      payload: thirdPayload,
      reentrantOwner: owner,
    });
    expect(thirdPayload).not.toHaveBeenCalled();
    third.release();
    expect(fs.existsSync(outer.lockPath)).toBe(true);
    armed = false;
    inner!.release();
    expect(fs.existsSync(outer.lockPath)).toBe(false);
  });

  it("creates missing custom sidecar parents through retained Root authority", async () => {
    const directory = await tempRoot("fs-safe-sync-root-custom-");
    const lockRoot = await root(directory);
    const target = path.join(directory, "external-key.json");
    const lockPath = path.join(directory, "nested", "locks", "custom.lock");
    const protectedWork = vi.fn(() => "done");
    expect(withFileLockSync(target, {
      lockPath,
      lockRoot,
      payload: () => ({ owner: "test" }),
    }, protectedWork)).toBe("done");
    expect(protectedWork).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.statSync(path.dirname(lockPath)).isDirectory()).toBe(true);
  });

  it("snapshots Root policy and acquisition inputs before payload callbacks", async () => {
    const directory = await tempRoot("fs-safe-sync-root-snapshot-");
    const deniedPaths: string[] = [];
    const lockRoot = await root(directory, { denyMutations: { paths: deniedPaths } });
    const lockPath = path.join(directory, "original.lock");
    const changedPath = path.join(directory, "changed.lock");
    const originalParser = vi.fn((raw: string) => JSON.parse(raw));
    const changedParser = vi.fn(() => { throw new Error("changed parser used"); });
    const options = {
      lockPath,
      lockRoot,
      parsePayload: originalParser,
      payload: () => {
        deniedPaths.push(lockPath);
        options.lockPath = changedPath;
        options.parsePayload = changedParser;
        return { owner: "test" };
      },
    };
    const lock = acquireFileLockSync(path.join(directory, "state.json"), options);
    try {
      expect(lock.lockPath).toBe(lockPath);
      expect(lock.verifyStillHeld()).toBe(true);
      expect(originalParser).toHaveBeenCalledTimes(1);
      expect(changedParser).not.toHaveBeenCalled();
      expect(fs.existsSync(changedPath)).toBe(false);
    } finally {
      lock.release();
    }
  });

  it("reads every Root-route option and retry getter exactly once before validation", async () => {
    const directory = await tempRoot("fs-safe-sync-root-getters-");
    const lockRoot = await root(directory);
    const calls = new Map<string, number>();
    const accessed = (name: string, value: unknown) => () => {
      calls.set(name, (calls.get(name) ?? 0) + 1);
      return value;
    };
    const retry = {} as Record<string, unknown>;
    for (const [name, value] of Object.entries({
      retries: 0,
      factor: 1,
      minTimeout: 0,
      maxTimeout: 0,
      randomize: false,
    })) {
      Object.defineProperty(retry, name, {
        enumerable: true,
        get: accessed(`retry.${name}`, value),
      });
    }
    let payloadReceiver: unknown;
    const options = {} as FileLockSyncAcquireOptions<{ owner: string }>;
    const values: Record<string, unknown> = {
      lockPath: path.join(directory, "state.lock"),
      staleMs: 0,
      timeoutMs: 0,
      retry,
      staleRecovery: "fail-closed",
      reentrantOwner: "getter-owner",
      payload: function (this: unknown) {
        payloadReceiver = this;
        return { owner: "test" };
      },
      shouldReclaim: undefined,
      shouldRemoveStaleLock: undefined,
      parsePayload: undefined,
      lockRoot,
      onCompromised: undefined,
      compromiseCheckIntervalMs: 0,
    };
    for (const [name, value] of Object.entries(values)) {
      Object.defineProperty(options, name, { get: accessed(name, value) });
    }

    const lock = acquireFileLockSync(path.join(directory, "state.json"), options);
    try {
      expect(payloadReceiver).toBe(options);
      for (const name of Object.keys(values)) expect(calls.get(name)).toBe(1);
      for (const name of Object.keys(retry)) expect(calls.get(`retry.${name}`)).toBe(1);
    } finally {
      lock.release();
    }
  });

  it("preserves callback receivers while keeping custom parser invocation unbound", async () => {
    const directory = await tempRoot("fs-safe-sync-root-receivers-");
    const lockPath = path.join(directory, "state.lock");
    fs.writeFileSync(lockPath, "{}");
    const lockRoot = await root(directory);
    const receivers: Record<string, unknown> = {};
    const options: FileLockSyncAcquireOptions<{ owner: string }> = {
      ...immediate,
      lockPath,
      lockRoot,
      staleRecovery: "remove-if-unchanged",
      payload: function (this: unknown) {
        receivers.payload = this;
        return { owner: "new" };
      },
      parsePayload: function (this: unknown, raw: string) {
        receivers.parsePayload = this;
        return JSON.parse(raw) as unknown;
      },
      shouldReclaim: function (this: unknown) {
        receivers.shouldReclaim = this;
        return true;
      },
      shouldRemoveStaleLock: function (this: unknown) {
        receivers.shouldRemoveStaleLock = this;
        return true;
      },
    };
    const lock = acquireFileLockSync(path.join(directory, "state.json"), options);
    try {
      expect(receivers).toMatchObject({
        payload: options,
        shouldReclaim: options,
        shouldRemoveStaleLock: options,
      });
      expect(receivers.parsePayload).toBeUndefined();
    } finally {
      lock.release();
    }
  });

  it("invokes compromise callbacks with the original options receiver", async () => {
    vi.useFakeTimers();
    const directory = await tempRoot("fs-safe-sync-root-compromise-receiver-");
    const lockRoot = await root(directory);
    let receiver: unknown;
    const options: FileLockSyncAcquireOptions<{ owner: string }> = {
      lockRoot,
      payload: () => ({ owner: "test" }),
      compromiseCheckIntervalMs: 1,
      onCompromised: function (this: unknown) {
        receiver = this;
      },
    };
    const lock = acquireFileLockSync(path.join(directory, "state.json"), options);
    const cleanup = Reflect.get(
      globalThis,
      Symbol.for("fsSafe.syncRootSidecarLockCleanupHandler.v1"),
    ) as () => void;
    try {
      fs.writeFileSync(lock.lockPath, "changed");
      vi.advanceTimersByTime(1);
      expect(receiver).toBe(options);
      expect(() => lock.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    } finally {
      cleanup();
      if (fs.existsSync(lock.lockPath)) fs.unlinkSync(lock.lockPath);
      lock.release();
    }
  });

});
