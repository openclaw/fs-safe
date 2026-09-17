import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { pathForWindowsFilesystem } from "../src/windows-path-alias.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const immediate = { timeoutMs: 0, retry: { retries: 0 } } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("synchronous Root-backed file-lock replacement authority", () => {
  it("rejects Root replacement before reentrant reuse, verification, and release", async () => {
    const directory = await tempRoot("fs-safe-sync-root-replaced-");
    const original = path.join(directory, "root");
    const moved = path.join(directory, "moved");
    const observedReplacement = path.join(directory, "observed-replacement");
    fs.mkdirSync(original);
    const lockRoot = await root(original);
    const payload = vi.fn(() => ({ owner: "test" }));
    const options = {
      ...immediate,
      lockRoot,
      payload,
      reentrantOwner: "operation",
    };
    const lock = acquireFileLockSync(path.join(original, "state.json"), options);
    let reentrant: ReturnType<typeof acquireFileLockSync> | undefined;
    let observationArmed = false;
    let rootObservations = 0;
    let observation: { mockRestore(): void } | undefined;
    let observationDirectoryCreated = false;
    let originalMoved = false;
    let replacementCreated = false;
    try {
      const reused = acquireFileLockSync(path.join(original, "state.json"), options);
      reentrant = reused;
      const sidecarBytes = fs.readFileSync(lock.lockPath);
      const sidecarIdentity = fs.lstatSync(lock.lockPath, { bigint: true });
      if (process.platform === "win32") {
        // Windows correctly keeps a directory containing the owned sidecar fd
        // immovable. Model only the Root identity observation with another real
        // directory so the descriptor-bound sidecar and validator stay real.
        fs.mkdirSync(observedReplacement);
        observationDirectoryCreated = true;
        const originalIdentity = fs.lstatSync(original, { bigint: true });
        const replacementIdentity = fs.lstatSync(observedReplacement, { bigint: true });
        expect([replacementIdentity.dev, replacementIdentity.ino])
          .not.toEqual([originalIdentity.dev, originalIdentity.ino]);
        const lstat = fs.lstatSync.bind(fs);
        observation = vi.spyOn(fs, "lstatSync").mockImplementation(
          ((...args: Parameters<typeof fs.lstatSync>) => {
            if (observationArmed && args[1]?.bigint === true &&
              String(args[0]) === pathForWindowsFilesystem(lockRoot.rootReal)) {
              rootObservations += 1;
              return replacementIdentity;
            }
            return lstat(...args);
          }) as typeof fs.lstatSync,
        );
        observationArmed = true;
      } else {
        fs.renameSync(original, moved);
        originalMoved = true;
        fs.mkdirSync(original);
        replacementCreated = true;
      }
      payload.mockClear();
      let observationsBefore = rootObservations;
      expect(() => acquireFileLockSync(path.join(original, "state.json"), options))
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(rootObservations).toBeGreaterThan(observationsBefore);
      }
      expect(payload).not.toHaveBeenCalled();
      observationsBefore = rootObservations;
      expect(() => lock.verifyStillHeld()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(rootObservations).toBeGreaterThan(observationsBefore);
      }
      observationsBefore = rootObservations;
      expect(() => reused.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(rootObservations).toBeGreaterThan(observationsBefore);
      }
      observationsBefore = rootObservations;
      expect(() => lock.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(rootObservations).toBeGreaterThan(observationsBefore);
        expect(fs.readFileSync(lock.lockPath)).toEqual(sidecarBytes);
        const currentIdentity = fs.lstatSync(lock.lockPath, { bigint: true });
        expect([currentIdentity.dev, currentIdentity.ino])
          .toEqual([sidecarIdentity.dev, sidecarIdentity.ino]);
      } else {
        expect(fs.existsSync(path.join(moved, "state.json.lock"))).toBe(true);
        expect(fs.existsSync(path.join(original, "state.json.lock"))).toBe(false);
      }
    } finally {
      observationArmed = false;
      observation?.mockRestore();
      if (observationDirectoryCreated && fs.existsSync(observedReplacement)) {
        fs.rmdirSync(observedReplacement);
      }
      if (replacementCreated && fs.existsSync(original)) fs.rmdirSync(original);
      if (originalMoved && fs.existsSync(moved) && !fs.existsSync(original)) {
        fs.renameSync(moved, original);
      }
      try {
        reentrant?.release();
      } finally {
        lock.release();
      }
    }
  });

  it("rejects the same lock inode reached through a replacement parent", async () => {
    const directory = await tempRoot("fs-safe-sync-root-parent-replaced-");
    const parent = path.join(directory, "locks");
    const movedParent = path.join(directory, "moved-locks");
    fs.mkdirSync(parent);
    const lockPath = path.join(parent, "state.lock");
    const lockRoot = await root(directory, { hardlinks: "allow" });
    const payload = vi.fn(() => ({ owner: "test" }));
    const lock = acquireFileLockSync(path.join(directory, "state.json"), {
      lockPath,
      lockRoot,
      payload,
    });
    const observedReplacement = path.join(directory, "observed-parent");
    let observationArmed = false;
    let parentObservations = 0;
    let observation: { mockRestore(): void } | undefined;
    let observationDirectoryCreated = false;
    let parentMoved = false;
    let replacementParentCreated = false;
    let replacementLinkCreated = false;
    try {
      const sidecarBytes = fs.readFileSync(lockPath);
      const sidecarIdentity = fs.lstatSync(lockPath, { bigint: true });
      if (process.platform === "win32") {
        // Keep the owned sidecar open and real; replace only the retained-parent
        // observation with the exact identity of another physical directory.
        fs.mkdirSync(observedReplacement);
        observationDirectoryCreated = true;
        const parentIdentity = fs.lstatSync(parent, { bigint: true });
        const replacementIdentity = fs.lstatSync(observedReplacement, { bigint: true });
        expect([replacementIdentity.dev, replacementIdentity.ino])
          .not.toEqual([parentIdentity.dev, parentIdentity.ino]);
        const lstat = fs.lstatSync.bind(fs);
        observation = vi.spyOn(fs, "lstatSync").mockImplementation(
          ((...args: Parameters<typeof fs.lstatSync>) => {
            if (observationArmed && args[1]?.bigint === true &&
              String(args[0]) === pathForWindowsFilesystem(parent)) {
              parentObservations += 1;
              return replacementIdentity;
            }
            return lstat(...args);
          }) as typeof fs.lstatSync,
        );
        observationArmed = true;
      } else {
        fs.renameSync(parent, movedParent);
        parentMoved = true;
        fs.mkdirSync(parent);
        replacementParentCreated = true;
        fs.linkSync(path.join(movedParent, "state.lock"), lockPath);
        replacementLinkCreated = true;
      }
      let observationsBefore = parentObservations;
      expect(() => lock.verifyStillHeld())
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(parentObservations).toBeGreaterThan(observationsBefore);
      }
      observationsBefore = parentObservations;
      expect(() => lock.release())
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(parentObservations).toBeGreaterThan(observationsBefore);
      }
      expect(payload).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(lockPath)).toEqual(sidecarBytes);
      const currentIdentity = fs.lstatSync(lockPath, { bigint: true });
      expect([currentIdentity.dev, currentIdentity.ino])
        .toEqual([sidecarIdentity.dev, sidecarIdentity.ino]);
      if (process.platform !== "win32") {
        expect(fs.existsSync(path.join(movedParent, "state.lock"))).toBe(true);
      }
    } finally {
      observationArmed = false;
      observation?.mockRestore();
      if (observationDirectoryCreated && fs.existsSync(observedReplacement)) {
        fs.rmdirSync(observedReplacement);
      }
      if (replacementLinkCreated && fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      if (replacementParentCreated && fs.existsSync(parent)) fs.rmdirSync(parent);
      if (parentMoved && fs.existsSync(movedParent) && !fs.existsSync(parent)) {
        fs.renameSync(movedParent, parent);
      }
      lock.release();
    }
  });

  it("revalidates the retained parent after a verification parser callback", async () => {
    const directory = await tempRoot("fs-safe-sync-root-parser-parent-");
    const parent = path.join(directory, "locks");
    const movedParent = path.join(directory, "moved-locks");
    fs.mkdirSync(parent);
    const lockPath = path.join(parent, "state.lock");
    const lockRoot = await root(directory, { hardlinks: "allow" });
    const observedReplacement = path.join(directory, "observed-parent");
    let observationArmed = false;
    let parentObservations = 0;
    let observation: { mockRestore(): void } | undefined;
    let observationDirectoryCreated = false;
    let parentMoved = false;
    let replacementParentCreated = false;
    let replacementLinkCreated = false;
    const payload = vi.fn(() => ({ owner: "test" }));
    const parsePayload = vi.fn((raw: string) => {
      if (process.platform === "win32") {
        observationArmed = true;
      } else {
        fs.renameSync(parent, movedParent);
        parentMoved = true;
        fs.mkdirSync(parent);
        replacementParentCreated = true;
        fs.linkSync(path.join(movedParent, "state.lock"), lockPath);
        replacementLinkCreated = true;
      }
      return JSON.parse(raw) as unknown;
    });
    const lock = acquireFileLockSync(path.join(directory, "state.json"), {
      lockPath,
      lockRoot,
      payload,
      parsePayload,
    });
    try {
      const sidecarBytes = fs.readFileSync(lockPath);
      const sidecarIdentity = fs.lstatSync(lockPath, { bigint: true });
      if (process.platform === "win32") {
        // The parser arms this observation after the first descriptor-bound
        // snapshot, leaving the post-callback validator as the failing fence.
        fs.mkdirSync(observedReplacement);
        observationDirectoryCreated = true;
        const parentIdentity = fs.lstatSync(parent, { bigint: true });
        const replacementIdentity = fs.lstatSync(observedReplacement, { bigint: true });
        expect([replacementIdentity.dev, replacementIdentity.ino])
          .not.toEqual([parentIdentity.dev, parentIdentity.ino]);
        const lstat = fs.lstatSync.bind(fs);
        observation = vi.spyOn(fs, "lstatSync").mockImplementation(
          ((...args: Parameters<typeof fs.lstatSync>) => {
            if (observationArmed && args[1]?.bigint === true &&
              String(args[0]) === pathForWindowsFilesystem(parent)) {
              parentObservations += 1;
              return replacementIdentity;
            }
            return lstat(...args);
          }) as typeof fs.lstatSync,
        );
      }
      expect(() => lock.verifyStillHeld())
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(parsePayload).toHaveBeenCalledTimes(1);
      expect(payload).toHaveBeenCalledTimes(1);
      if (process.platform === "win32") expect(parentObservations).toBeGreaterThan(0);
      else expect(parentMoved && replacementParentCreated && replacementLinkCreated).toBe(true);
      expect(fs.readFileSync(lockPath)).toEqual(sidecarBytes);
      const currentIdentity = fs.lstatSync(lockPath, { bigint: true });
      expect([currentIdentity.dev, currentIdentity.ino])
        .toEqual([sidecarIdentity.dev, sidecarIdentity.ino]);
    } finally {
      observationArmed = false;
      observation?.mockRestore();
      if (observationDirectoryCreated && fs.existsSync(observedReplacement)) {
        fs.rmdirSync(observedReplacement);
      }
      if (replacementLinkCreated && fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      if (replacementParentCreated && fs.existsSync(parent)) fs.rmdirSync(parent);
      if (parentMoved && fs.existsSync(movedParent) && !fs.existsSync(parent)) {
        fs.renameSync(movedParent, parent);
      }
      lock.release();
    }
  });

});
