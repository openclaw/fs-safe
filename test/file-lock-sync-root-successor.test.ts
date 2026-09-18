import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { serializeSidecarLockPayload } from "../src/sidecar-lock-reclaim.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

function settleIntentionallyFailedRelease(owner: ReturnType<typeof acquireFileLockSync>): void {
  const cleanup = Reflect.get(
    globalThis,
    Symbol.for("fsSafe.syncRootSidecarLockCleanupHandler.v1"),
  ) as (() => void) | undefined;
  if (!cleanup) throw new Error("expected synchronous Root lock cleanup handler");
  cleanup();
  owner.release();
}

describe("synchronous Root-backed file-lock lifecycle", () => {
  it("preserves a distinct successor published immediately after owned removal", async () => {
    const directory = await tempRoot("fs-safe-sync-root-release-successor-");
    const target = path.join(directory, "state.json");
    const lockRoot = await root(directory);
    const owner = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "original" }),
    });
    const successorRaw = serializeSidecarLockPayload({ owner: "successor" }).raw;
    const realUnlink = fs.unlinkSync.bind(fs);
    let successorPublished = false;
    const remove = vi.spyOn(fs, "unlinkSync").mockImplementation((candidate, ...args) => {
      realUnlink(candidate, ...args);
      if (!successorPublished) {
        fs.writeFileSync(owner.lockPath, successorRaw, { flag: "wx", mode: 0o600 });
        successorPublished = true;
      }
    });
    try {
      owner.release();
      expect(successorPublished).toBe(true);
      expect(fs.readFileSync(owner.lockPath, "utf8")).toBe(successorRaw);
      expect(owner.verifyStillHeld()).toBe(false);
      owner.release();
      expect(fs.readFileSync(owner.lockPath, "utf8")).toBe(successorRaw);
    } finally {
      remove.mockRestore();
      if (fs.existsSync(owner.lockPath)) fs.unlinkSync(owner.lockPath);
      owner.release();
    }
  });

  it("rejects an unresolved Windows successor identity after owned removal", async () => {
    const directory = await tempRoot("fs-safe-sync-root-release-unknown-successor-");
    const target = path.join(directory, "state.json");
    const lockRoot = await root(directory);
    const owner = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "original" }),
    });
    const successorRaw = serializeSidecarLockPayload({ owner: "successor" }).raw;
    const realUnlink = fs.unlinkSync.bind(fs);
    const realLstat = fs.lstatSync.bind(fs);
    let successorPublished = false;
    let unknownObservations = 0;
    const remove = vi.spyOn(fs, "unlinkSync").mockImplementation((candidate, ...args) => {
      realUnlink(candidate, ...args);
      fs.writeFileSync(owner.lockPath, successorRaw, { flag: "wx", mode: 0o600 });
      successorPublished = true;
    });
    Object.defineProperty(process, "platform", { value: "win32" });
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = realLstat(...args);
      if (!successorPublished || String(args[0]) !== owner.lockPath || !args[1]?.bigint) return stat;
      unknownObservations++;
      return Object.assign(Object.create(stat), { dev: 0n, ino: 0n });
    }) as typeof fs.lstatSync);
    try {
      expect(() => owner.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(unknownObservations).toBe(2);
      expect(fs.readFileSync(owner.lockPath, "utf8")).toBe(successorRaw);
    } finally {
      lstat.mockRestore();
      remove.mockRestore();
      Object.defineProperty(process, "platform", platform);
      settleIntentionallyFailedRelease(owner);
      if (fs.existsSync(owner.lockPath)) fs.unlinkSync(owner.lockPath);
    }
  });

  it("rejects an unverifiable same-identity successor snapshot", async () => {
    const directory = await tempRoot("fs-safe-sync-root-release-ambiguous-successor-");
    const target = path.join(directory, "state.json");
    const lockRoot = await root(directory);
    const owner = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "original" }),
    });
    const ownedIdentity = fs.lstatSync(owner.lockPath, { bigint: true });
    const successorRaw = serializeSidecarLockPayload({ owner: "successor" }).raw;
    const realUnlink = fs.unlinkSync.bind(fs);
    const realLstat = fs.lstatSync.bind(fs);
    const realFstat = fs.fstatSync.bind(fs);
    let successorPublished = false;
    let descriptorMismatchObserved = false;
    const remove = vi.spyOn(fs, "unlinkSync").mockImplementation((candidate, ...args) => {
      realUnlink(candidate, ...args);
      fs.writeFileSync(owner.lockPath, successorRaw, { flag: "wx", mode: 0o600 });
      successorPublished = true;
    });
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = realLstat(...args);
      if (!successorPublished || String(args[0]) !== owner.lockPath || !args[1]?.bigint) return stat;
      return Object.assign(Object.create(stat), { dev: ownedIdentity.dev, ino: ownedIdentity.ino });
    }) as typeof fs.lstatSync);
    const fstat = vi.spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      const stat = realFstat(...args);
      if (!successorPublished || !args[1]?.bigint || !stat.isFile()) return stat;
      descriptorMismatchObserved = true;
      return Object.assign(Object.create(stat), { dev: ownedIdentity.dev, ino: ownedIdentity.ino + 1n });
    }) as typeof fs.fstatSync);
    try {
      expect(() => owner.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(descriptorMismatchObserved).toBe(true);
      expect(fs.readFileSync(owner.lockPath, "utf8")).toBe(successorRaw);
    } finally {
      fstat.mockRestore();
      lstat.mockRestore();
      remove.mockRestore();
      settleIntentionallyFailedRelease(owner);
      if (fs.existsSync(owner.lockPath)) fs.unlinkSync(owner.lockPath);
    }
  });

  it("rejects a successor snapshot admitted through a replaced nested parent", async () => {
    const directory = await tempRoot("fs-safe-sync-root-release-parent-swap-");
    const nested = path.join(directory, "nested");
    const moved = path.join(directory, "moved");
    fs.mkdirSync(nested);
    const target = path.join(nested, "state.json");
    const lockRoot = await root(directory);
    const owner = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "original" }),
    });
    const ownedIdentity = fs.lstatSync(owner.lockPath, { bigint: true });
    const successorRaw = serializeSidecarLockPayload({ owner: "successor" }).raw;
    const replacementRaw = serializeSidecarLockPayload({ owner: "replacement-parent" }).raw;
    const realUnlink = fs.unlinkSync.bind(fs);
    const realLstat = fs.lstatSync.bind(fs);
    let successorPublished = false;
    let lockObservations = 0;
    let parentSwapped = false;
    const remove = vi.spyOn(fs, "unlinkSync").mockImplementation((candidate, ...args) => {
      realUnlink(candidate, ...args);
      fs.writeFileSync(owner.lockPath, successorRaw, { flag: "wx", mode: 0o600 });
      successorPublished = true;
    });
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = realLstat(...args);
      if (!successorPublished || String(args[0]) !== owner.lockPath || !args[1]?.bigint) return stat;
      lockObservations++;
      if (lockObservations === 1) {
        return Object.assign(Object.create(stat), { dev: ownedIdentity.dev, ino: ownedIdentity.ino });
      }
      if (lockObservations === 2) {
        fs.renameSync(nested, moved);
        fs.mkdirSync(nested);
        fs.writeFileSync(owner.lockPath, replacementRaw, { flag: "wx", mode: 0o600 });
        parentSwapped = true;
        return realLstat(...args);
      }
      return stat;
    }) as typeof fs.lstatSync);
    try {
      expect(() => owner.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(parentSwapped).toBe(true);
      expect(lockObservations).toBe(3);
      expect(fs.readFileSync(path.join(moved, path.basename(owner.lockPath)), "utf8")).toBe(successorRaw);
      expect(fs.readFileSync(owner.lockPath, "utf8")).toBe(replacementRaw);
    } finally {
      lstat.mockRestore();
      remove.mockRestore();
      settleIntentionallyFailedRelease(owner);
      if (fs.existsSync(nested)) fs.rmSync(nested, { recursive: true });
      if (fs.existsSync(moved)) fs.renameSync(moved, nested);
      if (fs.existsSync(owner.lockPath)) fs.unlinkSync(owner.lockPath);
    }
  });
});
