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

function directoryReplacement(
  original: string,
  moved: string,
  observed: string,
  observedPath: string,
  linkName?: string,
) {
  let armed = false;
  let observations = 0;
  let observation: { mockRestore(): void } | undefined;
  let observedCreated = false;
  let originalMoved = false;
  let replacementCreated = false;
  let linkCreated = false;
  return {
    prepare() {
      if (process.platform !== "win32") return;
      // Windows pins the directory with the owned sidecar fd; change only its observed identity.
      fs.mkdirSync(observed);
      observedCreated = true;
      const originalIdentity = fs.lstatSync(original, { bigint: true });
      const replacementIdentity = fs.lstatSync(observed, { bigint: true });
      expect([replacementIdentity.dev, replacementIdentity.ino])
        .not.toEqual([originalIdentity.dev, originalIdentity.ino]);
      const lstat = fs.lstatSync.bind(fs);
      observation = vi.spyOn(fs, "lstatSync").mockImplementation(
        ((...args: Parameters<typeof fs.lstatSync>) => {
          if (armed && args[1]?.bigint === true && String(args[0]) === pathForWindowsFilesystem(observedPath)) {
            observations += 1;
            return replacementIdentity;
          }
          return lstat(...args);
        }) as typeof fs.lstatSync,
      );
    },
    replace() {
      if (process.platform === "win32") {
        armed = true;
        return;
      }
      fs.renameSync(original, moved);
      originalMoved = true;
      fs.mkdirSync(original);
      replacementCreated = true;
      if (linkName) {
        fs.linkSync(path.join(moved, linkName), path.join(original, linkName));
        linkCreated = true;
      }
    },
    get observations() { return observations; },
    get linkedReplacement() { return originalMoved && replacementCreated && linkCreated; },
    restore() {
      armed = false;
      observation?.mockRestore();
      if (observedCreated && fs.existsSync(observed)) fs.rmdirSync(observed);
      if (linkCreated && linkName && fs.existsSync(path.join(original, linkName))) {
        fs.unlinkSync(path.join(original, linkName));
      }
      if (replacementCreated && fs.existsSync(original)) fs.rmdirSync(original);
      if (originalMoved && fs.existsSync(moved) && !fs.existsSync(original)) fs.renameSync(moved, original);
    },
  };
}

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
    const replacement = directoryReplacement(original, moved, observedReplacement, lockRoot.rootReal);
    try {
      const reused = acquireFileLockSync(path.join(original, "state.json"), options);
      reentrant = reused;
      const sidecarBytes = fs.readFileSync(lock.lockPath);
      const sidecarIdentity = fs.lstatSync(lock.lockPath, { bigint: true });
      replacement.prepare();
      replacement.replace();
      payload.mockClear();
      let observationsBefore = replacement.observations;
      expect(() => acquireFileLockSync(path.join(original, "state.json"), options))
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(replacement.observations).toBeGreaterThan(observationsBefore);
      }
      expect(payload).not.toHaveBeenCalled();
      observationsBefore = replacement.observations;
      expect(() => lock.verifyStillHeld()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(replacement.observations).toBeGreaterThan(observationsBefore);
      }
      observationsBefore = replacement.observations;
      expect(() => reused.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(replacement.observations).toBeGreaterThan(observationsBefore);
      }
      observationsBefore = replacement.observations;
      expect(() => lock.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(replacement.observations).toBeGreaterThan(observationsBefore);
        expect(fs.readFileSync(lock.lockPath)).toEqual(sidecarBytes);
        const currentIdentity = fs.lstatSync(lock.lockPath, { bigint: true });
        expect([currentIdentity.dev, currentIdentity.ino])
          .toEqual([sidecarIdentity.dev, sidecarIdentity.ino]);
      } else {
        expect(fs.existsSync(path.join(moved, "state.json.lock"))).toBe(true);
        expect(fs.existsSync(path.join(original, "state.json.lock"))).toBe(false);
      }
    } finally {
      replacement.restore();
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
    const replacement = directoryReplacement(parent, movedParent, observedReplacement, parent, "state.lock");
    try {
      const sidecarBytes = fs.readFileSync(lockPath);
      const sidecarIdentity = fs.lstatSync(lockPath, { bigint: true });
      replacement.prepare();
      replacement.replace();
      let observationsBefore = replacement.observations;
      expect(() => lock.verifyStillHeld())
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(replacement.observations).toBeGreaterThan(observationsBefore);
      }
      observationsBefore = replacement.observations;
      expect(() => lock.release())
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      if (process.platform === "win32") {
        expect(replacement.observations).toBeGreaterThan(observationsBefore);
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
      replacement.restore();
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
    const replacement = directoryReplacement(parent, movedParent, observedReplacement, parent, "state.lock");
    const payload = vi.fn(() => ({ owner: "test" }));
    const parsePayload = vi.fn((raw: string) => {
      // Arm only after the first snapshot so the post-parser identity fence rejects it.
      replacement.replace();
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
      replacement.prepare();
      expect(() => lock.verifyStillHeld())
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(parsePayload).toHaveBeenCalledTimes(1);
      expect(payload).toHaveBeenCalledTimes(1);
      if (process.platform === "win32") expect(replacement.observations).toBeGreaterThan(0);
      else expect(replacement.linkedReplacement).toBe(true);
      expect(fs.readFileSync(lockPath)).toEqual(sidecarBytes);
      const currentIdentity = fs.lstatSync(lockPath, { bigint: true });
      expect([currentIdentity.dev, currentIdentity.ino])
        .toEqual([sidecarIdentity.dev, sidecarIdentity.ino]);
    } finally {
      replacement.restore();
      lock.release();
    }
  });

});
