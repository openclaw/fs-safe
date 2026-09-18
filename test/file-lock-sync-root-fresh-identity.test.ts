import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileLockSyncRootSnapshot } from "../src/file-lock-sync-root-io.js";
import { fileLockSyncRootGuardExists } from "../src/file-lock-sync-root-mutation.js";
import {
  admitFileLockSyncRootPath,
  captureFileLockSyncRootAuthority,
} from "../src/file-lock-sync-root.js";
import { root } from "../src/root.js";
import { acquireFileLockSync } from "../src/file-lock.js";
import { serializeSidecarLockPayload } from "../src/sidecar-lock-reclaim.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("synchronous Root-backed fresh inspection identity", () => {
  it("does not derive creator authority from token-shaped disk bytes", async () => {
    const directory = await tempRoot("fs-safe-sync-root-disk-token-");
    const lockPath = path.join(directory, "state.lock");
    const serialized = serializeSidecarLockPayload({ owner: "untrusted-disk" });
    fs.writeFileSync(lockPath, serialized.raw);
    const lockRoot = await root(directory);
    const rootPath = admitFileLockSyncRootPath(
      captureFileLockSyncRootAuthority(lockRoot),
      lockPath,
    );
    const observed = readFileLockSyncRootSnapshot(rootPath);
    expect(serialized.raw).toContain(serialized.ownershipToken);
    expect(observed?.snapshot.raw).toBe(serialized.raw);
    expect(observed?.snapshot.payload).toBeNull();
    expect(observed?.snapshot).not.toHaveProperty("ownershipToken");
  });

  it("rejects a replaced Root before opening a fresh sidecar snapshot", async () => {
    const directory = await tempRoot("fs-safe-sync-root-fresh-entry-");
    const original = path.join(directory, "root");
    const moved = path.join(directory, "moved");
    fs.mkdirSync(original);
    const lockPath = path.join(original, "state.lock");
    fs.writeFileSync(lockPath, "original");
    const lockRoot = await root(original);
    const rootPath = admitFileLockSyncRootPath(
      captureFileLockSyncRootAuthority(lockRoot),
      lockPath,
    );
    fs.renameSync(original, moved);
    fs.mkdirSync(original);
    fs.writeFileSync(lockPath, "replacement");
    const open = vi.spyOn(fs, "openSync");
    try {
      expect(() => readFileLockSyncRootSnapshot(rootPath))
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(open).not.toHaveBeenCalled();
      expect(fs.readFileSync(lockPath, "utf8")).toBe("replacement");
      expect(fs.readFileSync(path.join(moved, "state.lock"), "utf8")).toBe("original");
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(original, { force: true, recursive: true });
      fs.renameSync(moved, original);
    }
  });

  it("rechecks captured Root identity when a fresh snapshot open goes missing", async () => {
    const directory = await tempRoot("fs-safe-sync-root-fresh-snapshot-");
    const original = path.join(directory, "root");
    const moved = path.join(directory, "moved");
    fs.mkdirSync(original);
    const lockPath = path.join(original, "state.lock");
    fs.writeFileSync(lockPath, "{}");
    const lockRoot = await root(original);
    const rootPath = admitFileLockSyncRootPath(
      captureFileLockSyncRootAuthority(lockRoot),
      lockPath,
    );
    const missing = Object.assign(new Error("snapshot disappeared"), {
      code: "ENOENT",
      path: lockPath,
    });
    let swapped = false;
    vi.spyOn(fs, "openSync").mockImplementation(() => {
      fs.renameSync(original, moved);
      fs.mkdirSync(original);
      swapped = true;
      throw missing;
    });
    try {
      expect(() => readFileLockSyncRootSnapshot(rootPath))
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(fs.readFileSync(path.join(moved, "state.lock"), "utf8")).toBe("{}");
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      if (swapped) {
        fs.rmdirSync(original);
        fs.renameSync(moved, original);
      }
    }
  });

  it("rechecks captured Root identity before directoryExists returns", async () => {
    const directory = await tempRoot("fs-safe-sync-root-fresh-directory-");
    const original = path.join(directory, "root");
    const moved = path.join(directory, "moved");
    fs.mkdirSync(original);
    const guardPath = path.join(original, "state.lock.reclaim");
    fs.mkdirSync(guardPath);
    const lockRoot = await root(original);
    const rootPath = admitFileLockSyncRootPath(
      captureFileLockSyncRootAuthority(lockRoot),
      guardPath,
    );
    const actualLstat = fs.lstatSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "lstatSync").mockImplementation((pathname, options) => {
      if (!swapped && String(pathname) === guardPath) {
        fs.renameSync(original, moved);
        fs.mkdirSync(original);
        fs.mkdirSync(guardPath);
        swapped = true;
      }
      return actualLstat(pathname, options as never);
    });
    try {
      expect(() => fileLockSyncRootGuardExists(rootPath, true))
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(swapped).toBe(true);
      expect(fs.statSync(guardPath).isDirectory()).toBe(true);
      expect(fs.statSync(path.join(moved, "state.lock.reclaim")).isDirectory()).toBe(true);
    } finally {
      vi.restoreAllMocks();
      if (swapped) {
        fs.rmSync(original, { force: true, recursive: true });
        fs.renameSync(moved, original);
      }
    }
  });
});


it("preserves a replacement that replays the complete creator token and payload", async () => {
  const directory = await tempRoot("fs-safe-sync-root-replayed-token-");
  const lockRoot = await root(directory);
  const target = path.join(directory, "state");
  const lockPath = path.join(directory, "state.lock");
  const displaced = path.join(directory, "original.lock");
  const held = acquireFileLockSync(target, { lockRoot, lockPath, payload: () => ({ owner: "original" }) });
  const raw = fs.readFileSync(lockPath, "utf8");
  fs.renameSync(lockPath, displaced);
  fs.writeFileSync(lockPath, raw, { flag: "wx" });
  try {
    expect(held.verifyStillHeld()).toBe(false);
    expect(() => held.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(fs.readFileSync(lockPath, "utf8")).toBe(raw);
    expect(fs.readFileSync(displaced, "utf8")).toBe(raw);
  } finally {
    fs.unlinkSync(lockPath);
    fs.renameSync(displaced, lockPath);
    held.release();
  }
});
