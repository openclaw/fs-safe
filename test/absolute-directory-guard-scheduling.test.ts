import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAbsoluteDirectory, type EnsureAbsoluteDirectoryResult } from "../src/absolute-path.js";
import { FsSafeError, type FsSafeErrorCode } from "../src/errors.js";
import { realpathSync } from "../src/realpath.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

function queuedMutation() {
  let pending: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
  return {
    get scheduled() { return pending !== undefined; },
    schedule(mutate: () => void) {
      if (pending) throw new Error("mutation already scheduled");
      // Resolve both outcomes so failure cannot become an unhandled rejection.
      pending = new Promise(resolve => queueMicrotask(() => {
        try { mutate(); resolve({ ok: true }); }
        catch (error) { resolve({ ok: false, error }); }
      }));
    },
    async settle() {
      const outcome = await pending;
      if (outcome && !outcome.ok) throw outcome.error;
    },
  };
}

function assertFailure(result: EnsureAbsoluteDirectoryResult, code: FsSafeErrorCode): FsSafeError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("directory substitution unexpectedly succeeded");
  expect(result.code).toBe(code);
  expect(result.error).toBeInstanceOf(FsSafeError);
  return result.error;
}

function identity(candidate: string) {
  const { dev, ino } = fsSync.lstatSync(candidate, { bigint: true });
  return { dev, ino };
}

describe("absolute-directory guards across queued substitutions", () => {
  it("rechecks a parent replaced by a queued symlink after initial capture before reading mode or creating a child", async () => {
    const directory = await tempRoot("fs-safe-absolute-queued-parent-");
    const outside = await tempRoot("fs-safe-absolute-queued-outside-");
    const parent = path.join(directory, "parent");
    const retained = path.join(directory, "retained");
    const target = path.join(parent, "child");
    fsSync.mkdirSync(parent);
    const original = identity(parent);
    const mutation = queuedMutation();
    const events: string[] = [];
    const canonicalize = realpathSync.native;
    const mkdir = fs.mkdir.bind(fs);
    let modeReads = 0, mkdirCalls = 0;
    vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
      const resolved = canonicalize(candidate);
      if (candidate === parent && !mutation.scheduled) {
        events.push("captured-parent");
        mutation.schedule(() => {
          fsSync.renameSync(parent, retained);
          fsSync.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
          events.push("substituted-parent");
        });
      }
      return resolved;
    });
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      if (String(args[0]) === target) mkdirCalls += 1;
      return await mkdir(...args);
    });
    try {
      const result = await ensureAbsoluteDirectory(target, { get mode() { modeReads += 1; return 0o700; } });
      await mutation.settle();
      expect(mutation.scheduled).toBe(true);
      assertFailure(result, "symlink");
      expect(events).toEqual(["captured-parent", "substituted-parent"]);
      expect(modeReads).toBe(0);
      expect(mkdirCalls).toBe(0);
      expect(identity(retained)).toEqual(original);
      expect(fsSync.lstatSync(parent).isSymbolicLink()).toBe(true);
      expect(fsSync.readdirSync(retained)).toEqual([]);
      expect(fsSync.readdirSync(outside)).toEqual([]);
    } finally {
      try { await mutation.settle(); }
      finally { vi.restoreAllMocks(); }
    }
  });

  it.each([false, true])("checks the child again after a queued replacement at the previous-parent fence (large IDs: %s)", async largeIds => {
    const directory = await tempRoot("fs-safe-absolute-queued-child-");
    const parent = path.join(directory, "parent");
    const target = path.join(parent, "child");
    const retained = path.join(parent, "retained");
    fsSync.mkdirSync(parent);
    const mutation = queuedMutation();
    const events: string[] = [];
    const canonicalize = realpathSync.native;
    const mkdir = fs.mkdir.bind(fs);
    let captured: ReturnType<typeof identity> | undefined;
    let replacement: ReturnType<typeof identity> | undefined;
    let modeReads = 0, mkdirCalls = 0;
    if (largeIds) {
      const lstat = fsSync.lstatSync.bind(fsSync);
      const ids = new Map<bigint, bigint>();
      vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
        const stat = lstat(...args);
        if (stat && [target, retained].includes(String(args[0]))) {
          const exact = lstat(args[0], { bigint: true });
          // Valid 64-bit file IDs can collide when represented as Numbers.
          if (!ids.has(exact.ino)) ids.set(exact.ino, 2n ** 54n + BigInt(ids.size));
          const ino = ids.get(exact.ino)!;
          Object.assign(stat, { ino: typeof stat.ino === "bigint" ? ino : Number(ino) });
        }
        return stat;
      });
    }
    vi.spyOn(realpathSync, "native").mockImplementation(candidate => {
      const resolved = canonicalize(candidate);
      if (candidate === target && captured === undefined) {
        captured = identity(target);
        events.push("captured-child");
      } else if (candidate === parent && captured !== undefined && !mutation.scheduled) {
        events.push("checked-previous-parent");
        mutation.schedule(() => {
          fsSync.renameSync(target, retained);
          fsSync.mkdirSync(target);
          replacement = identity(target);
          events.push("substituted-child");
        });
      }
      return resolved;
    });
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      if (String(args[0]) === target) mkdirCalls += 1;
      return await mkdir(...args);
    });
    try {
      const result = await ensureAbsoluteDirectory(target, { get mode() { modeReads += 1; return 0o700; } });
      await mutation.settle();
      expect(mutation.scheduled).toBe(true);
      assertFailure(result, "path-mismatch");
      expect(events).toEqual(["captured-child", "checked-previous-parent", "substituted-child"]);
      expect(modeReads).toBe(1);
      expect(mkdirCalls).toBe(1);
      expect(captured).toBeDefined();
      expect(replacement).toBeDefined();
      expect(replacement).not.toEqual(captured);
      expect(identity(retained)).toEqual(captured);
      expect(identity(target)).toEqual(replacement);
      expect(fsSync.readdirSync(retained)).toEqual([]);
      expect(fsSync.readdirSync(target)).toEqual([]);
    } finally {
      try { await mutation.settle(); }
      finally { vi.restoreAllMocks(); }
    }
  });

  it("classifies the state actually reinspected when a refused symlink is removed in a queued mutation", async () => {
    const directory = await tempRoot("fs-safe-absolute-queued-reinspection-");
    const outside = await tempRoot("fs-safe-absolute-queued-reinspection-outside-");
    const parent = path.join(directory, "parent");
    const retained = path.join(directory, "retained");
    const target = path.join(parent, "child");
    fsSync.mkdirSync(parent);
    const original = identity(parent);
    const mutation = queuedMutation();
    const events: string[] = [];
    const lstat = fsSync.lstatSync.bind(fsSync);
    const mkdir = fs.mkdir.bind(fs);
    let parentReads = 0, modeReads = 0, mkdirCalls = 0;
    const observed: { reinspection?: { kind: "symlink" } | { kind: "missing"; error: unknown } } = {};
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) !== parent) return lstat(...args);
      parentReads += 1;
      // Prefix traversal read the real parent; its initial guard now sees a link.
      if (parentReads === 2) {
        fsSync.renameSync(parent, retained);
        fsSync.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
        const stat = lstat(...args);
        expect(stat.isSymbolicLink()).toBe(true);
        events.push("guard-observed-symlink");
        mutation.schedule(() => {
          fsSync.unlinkSync(parent);
          events.push("removed-symlink");
        });
        return stat;
      }
      if (parentReads === 3) {
        try {
          const stat = lstat(...args);
          expect(stat.isSymbolicLink()).toBe(true);
          observed.reinspection = { kind: "symlink" };
          events.push("reinspected-symlink");
          return stat;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          observed.reinspection = { kind: "missing", error };
          events.push("reinspected-missing");
          throw error;
        }
      }
      return lstat(...args);
    });
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      if (String(args[0]) === target) mkdirCalls += 1;
      return await mkdir(...args);
    });
    try {
      const result = await ensureAbsoluteDirectory(target, { get mode() { modeReads += 1; return 0o700; } });
      await mutation.settle();
      expect(mutation.scheduled).toBe(true);
      expect(parentReads).toBe(3);
      const reinspection = observed.reinspection;
      expect(reinspection).toBeDefined();
      if (reinspection?.kind === "symlink") {
        expect(assertFailure(result, "symlink").cause).toBeUndefined();
        expect(events).toEqual(["guard-observed-symlink", "reinspected-symlink", "removed-symlink"]);
      } else {
        if (!reinspection) throw new Error("refused parent was not reinspected");
        expect(assertFailure(result, "not-found").cause).toBe(reinspection.error);
        expect(events).toEqual(["guard-observed-symlink", "removed-symlink", "reinspected-missing"]);
      }
      expect(modeReads).toBe(0);
      expect(mkdirCalls).toBe(0);
      expect(fsSync.existsSync(parent)).toBe(false);
      expect(identity(retained)).toEqual(original);
      expect(fsSync.readdirSync(retained)).toEqual([]);
      expect(fsSync.readdirSync(outside)).toEqual([]);
    } finally {
      try { await mutation.settle(); }
      finally { vi.restoreAllMocks(); }
    }
  });
});
