import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import * as canonicalPath from "../src/realpath.js";
import { root, type Root } from "../src/root.js";
import { pathForWindowsFilesystem } from "../src/windows-path-alias.js";
import { itPosix, itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const immediate = { timeoutMs: 0, retry: { retries: 0 } } as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("synchronous Root-backed file-lock authority", () => {
  it("does not create an external target parent for an explicit in-root sidecar", async () => {
    const directory = await tempRoot("fs-safe-sync-root-external-");
    const lockDirectory = path.join(directory, "locks");
    fs.mkdirSync(lockDirectory);
    const lockRoot = await root(lockDirectory);
    const externalParent = path.join(directory, "external", "missing");
    const targetPath = path.join(externalParent, "state.json");
    const lockPath = path.join(lockDirectory, "state.lock");
    const lock = acquireFileLockSync(targetPath, {
      lockPath,
      lockRoot,
      payload: () => ({ owner: "test" }),
    });
    try {
      expect(lock.normalizedTargetPath).toBe(targetPath);
      expect(lock.lockPath).toBe(lockPath);
      expect(fs.existsSync(externalParent)).toBe(false);
      expect(lock.verifyStillHeld()).toBe(true);
    } finally {
      lock.release();
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("uses native existing-ancestor spelling to unify target arbitration keys", async () => {
    const directory = await tempRoot("fs-safe-sync-root-target-native-");
    const lockDirectory = path.join(directory, "locks");
    const longParent = path.join(directory, "long-spelling");
    const shortParent = path.join(directory, "short-spelling");
    fs.mkdirSync(lockDirectory);
    fs.mkdirSync(longParent);
    fs.mkdirSync(shortParent);
    const longTarget = path.join(longParent, "state.json");
    const shortTarget = path.join(shortParent, "state.json");
    fs.writeFileSync(longTarget, "long");
    fs.writeFileSync(shortTarget, "short");
    const lockRoot = await root(lockDirectory);
    const actualRealpath = process.platform === "win32"
      ? canonicalPath.realpathSync.native
      : canonicalPath.realpathSync;
    const longOperationPath = pathForWindowsFilesystem(
      process.platform === "win32" ? longTarget : longParent,
    );
    const shortOperationPath = pathForWindowsFilesystem(
      process.platform === "win32" ? shortTarget : shortParent,
    );
    const realpath = process.platform === "win32"
      ? vi.spyOn(canonicalPath.realpathSync, "native")
      : vi.spyOn(canonicalPath, "realpathSync");
    realpath.mockImplementation((input) => {
      if (input === longOperationPath || input === shortOperationPath) {
        return process.platform === "win32" ? longTarget : longParent;
      }
      return actualRealpath(input);
    });
    const lockPath = path.join(lockDirectory, "state.lock");
    const firstPayload = vi.fn(() => ({ owner: "first" }));
    const secondPayload = vi.fn(() => ({ owner: "second" }));
    const first = acquireFileLockSync(longTarget, {
      lockPath,
      lockRoot,
      payload: firstPayload,
      reentrantOwner: "same-owner",
    });
    const second = acquireFileLockSync(shortTarget, {
      lockPath,
      lockRoot,
      payload: secondPayload,
      reentrantOwner: "same-owner",
    });
    try {
      expect(first.normalizedTargetPath).toBe(longTarget);
      expect(second.normalizedTargetPath).toBe(first.normalizedTargetPath);
      expect(firstPayload).toHaveBeenCalledTimes(1);
      expect(secondPayload).not.toHaveBeenCalled();
    } finally {
      second.release();
      first.release();
    }
  });

  itWin32("identity-gates an alternate spelling of the original Root prefix", async () => {
    const directory = await tempRoot("fs-safe-sync-root-prefix-");
    const lockRoot = await root(directory);
    const alternateRoot = directory.replace(/[A-Za-z]/g, (character) =>
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase());
    const lock = acquireFileLockSync(path.join(directory, "state.json"), {
      lockPath: path.join(alternateRoot, "state.lock"),
      lockRoot,
      payload: () => ({ owner: "test" }),
    });
    try {
      expect(lock.lockPath).toBe(path.join(lockRoot.rootReal, "state.lock"));
    } finally {
      lock.release();
    }
  });

  it("never borrows a held lock across Root and raw state domains", async () => {
    const directory = await tempRoot("fs-safe-sync-root-mixed-");
    const target = path.join(directory, "state.json");
    const lockRoot = await root(directory);
    const owner = "same-owner";
    const rootHeld = acquireFileLockSync(target, {
      lockRoot,
      payload: () => ({ owner: "root" }),
      reentrantOwner: owner,
    });
    try {
      expect(() => acquireFileLockSync(target, {
        ...immediate,
        payload: () => ({ owner: "raw-contender" }),
        reentrantOwner: owner,
      })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
      expect(rootHeld.verifyStillHeld()).toBe(true);
    } finally {
      rootHeld.release();
    }

    const rawHeld = acquireFileLockSync(target, {
      payload: () => ({ owner: "raw" }),
      reentrantOwner: owner,
    });
    try {
      expect(() => acquireFileLockSync(target, {
        ...immediate,
        lockRoot,
        payload: () => ({ owner: "root-contender" }),
        reentrantOwner: owner,
      })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
      expect(rawHeld.verifyStillHeld()).toBe(true);
    } finally {
      rawHeld.release();
    }
  });

  it("rejects structural Root lookalikes before payload or filesystem effects", async () => {
    const directory = await tempRoot("fs-safe-sync-root-structural-");
    const genuine = await root(directory);
    const structural = Object.create(genuine) as Root;
    const payload = vi.fn(() => ({ owner: "test" }));
    const lockPath = path.join(directory, "state.lock");
    expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
      ...immediate,
      lockPath,
      lockRoot: structural,
      payload,
    })).toThrow(expect.objectContaining({ code: "helper-unavailable" }));
    expect(payload).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("applies denyMutations before payload evaluation or mutation", async () => {
    const directory = await tempRoot("fs-safe-sync-root-deny-");
    const lockPath = path.join(directory, "state.lock");
    const lockRoot = await root(directory, { denyMutations: { paths: [lockPath] } });
    const payload = vi.fn(() => ({ owner: "test" }));
    expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
      ...immediate,
      lockPath,
      lockRoot,
      payload,
    })).toThrow(expect.objectContaining({ code: "denied-path" }));
    expect(payload).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("runs the retained mutation assertion before payload evaluation", async () => {
    const directory = await tempRoot("fs-safe-sync-root-assert-");
    const refusal = new Error("lease expired");
    const assertBeforeMutation = vi.fn(() => { throw refusal; });
    const lockRoot = await root(directory, { assertBeforeMutation });
    const payload = vi.fn(() => ({ owner: "test" }));
    const lockPath = path.join(directory, "state.lock");
    expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
      lockPath,
      lockRoot,
      payload,
    })).toThrow(refusal);
    expect(assertBeforeMutation).toHaveBeenCalledTimes(1);
    expect(payload).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("rejects asynchronous Root mutation assertions before payload evaluation", async () => {
    const directory = await tempRoot("fs-safe-sync-root-async-assert-");
    const assertBeforeMutation = vi.fn(async () => undefined);
    const lockRoot = await root(directory, { assertBeforeMutation });
    const payload = vi.fn(() => ({ owner: "test" }));
    const lockPath = path.join(directory, "state.lock");
    expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
      lockPath,
      lockRoot,
      payload,
    })).toThrow(TypeError);
    expect(assertBeforeMutation).toHaveBeenCalledTimes(1);
    expect(payload).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("rejects Root replacement before reentrant reuse, verification, and release", async () => {
    const directory = await tempRoot("fs-safe-sync-root-replaced-");
    const original = path.join(directory, "root");
    const moved = path.join(directory, "moved");
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
    const reentrant = acquireFileLockSync(path.join(original, "state.json"), options);
    fs.renameSync(original, moved);
    fs.mkdirSync(original);
    try {
      payload.mockClear();
      expect(() => acquireFileLockSync(path.join(original, "state.json"), options))
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(payload).not.toHaveBeenCalled();
      expect(() => lock.verifyStillHeld()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(() => reentrant.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(() => lock.release()).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(fs.existsSync(path.join(moved, "state.json.lock"))).toBe(true);
      expect(fs.existsSync(path.join(original, "state.json.lock"))).toBe(false);
    } finally {
      fs.rmdirSync(original);
      fs.renameSync(moved, original);
      reentrant.release();
      lock.release();
    }
  });

  it("rejects the same lock inode reached through a replacement parent", async () => {
    const directory = await tempRoot("fs-safe-sync-root-parent-replaced-");
    const parent = path.join(directory, "locks");
    const movedParent = path.join(directory, "moved-locks");
    fs.mkdirSync(parent);
    const lockPath = path.join(parent, "state.lock");
    const lockRoot = await root(directory, { hardlinks: "allow" });
    const lock = acquireFileLockSync(path.join(directory, "state.json"), {
      lockPath,
      lockRoot,
      payload: () => ({ owner: "test" }),
    });
    fs.renameSync(parent, movedParent);
    fs.mkdirSync(parent);
    fs.linkSync(path.join(movedParent, "state.lock"), lockPath);
    try {
      expect(() => lock.verifyStillHeld())
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(() => lock.release())
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.existsSync(path.join(movedParent, "state.lock"))).toBe(true);
    } finally {
      fs.unlinkSync(lockPath);
      fs.rmdirSync(parent);
      fs.renameSync(movedParent, parent);
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
    let swapped = false;
    const lock = acquireFileLockSync(path.join(directory, "state.json"), {
      lockPath,
      lockRoot,
      payload: () => ({ owner: "test" }),
      parsePayload: (raw) => {
        fs.renameSync(parent, movedParent);
        fs.mkdirSync(parent);
        fs.linkSync(path.join(movedParent, "state.lock"), lockPath);
        swapped = true;
        return JSON.parse(raw) as unknown;
      },
    });
    try {
      expect(() => lock.verifyStillHeld())
        .toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(swapped).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      if (swapped) {
        fs.unlinkSync(lockPath);
        fs.rmdirSync(parent);
        fs.renameSync(movedParent, parent);
      }
      lock.release();
    }
  });

  it("rechecks retained Root authority after a payload callback race", async () => {
    const directory = await tempRoot("fs-safe-sync-root-payload-race-");
    const original = path.join(directory, "root");
    const moved = path.join(directory, "moved");
    fs.mkdirSync(original);
    const lockRoot = await root(original);
    const lockPath = path.join(original, "state.lock");
    const payload = vi.fn(() => {
      fs.renameSync(original, moved);
      fs.mkdirSync(original);
      return { owner: "test" };
    });
    try {
      expect(() => acquireFileLockSync(path.join(original, "state.json"), {
        lockPath,
        lockRoot,
        payload,
      })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
      expect(payload).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(original, "state.lock"))).toBe(false);
      expect(fs.existsSync(path.join(moved, "state.lock"))).toBe(false);
    } finally {
      fs.rmdirSync(original);
      fs.renameSync(moved, original);
    }
  });

  itPosix("applies parent symlink defaults and permits an explicit follow policy", async () => {
    const directory = await tempRoot("fs-safe-sync-root-parent-link-");
    const actual = path.join(directory, "actual");
    const alias = path.join(directory, "alias");
    fs.mkdirSync(actual);
    fs.symlinkSync("actual", alias, "dir");
    const target = path.join(directory, "state.json");
    const lockPath = path.join(alias, "state.lock");
    const payload = vi.fn(() => ({ owner: "test" }));
    const rejecting = await root(directory);
    expect(() => acquireFileLockSync(target, {
      ...immediate,
      lockPath,
      lockRoot: rejecting,
      payload,
    })).toThrow(expect.objectContaining({ code: "symlink" }));
    expect(payload).not.toHaveBeenCalled();

    const following = await root(directory, {
      mutationSymlinks: "follow-parents-within-root",
      symlinks: "follow-parents-within-root",
    });
    const lock = acquireFileLockSync(target, {
      ...immediate,
      lockPath,
      lockRoot: following,
      payload,
    });
    try {
      expect(lock.lockPath).toBe(path.join(actual, "state.lock"));
      expect(lock.verifyStillHeld()).toBe(true);
    } finally {
      lock.release();
    }
  });

  itPosix("uses one reclaim guard for equivalent final sidecar aliases", async () => {
    const directory = await tempRoot("fs-safe-sync-root-final-alias-guard-");
    const target = path.join(directory, "state.json");
    const canonicalLockPath = path.join(directory, "canonical.lock");
    const aliasLockPath = path.join(directory, "alias.lock");
    fs.writeFileSync(canonicalLockPath, "{}");
    fs.symlinkSync(path.basename(canonicalLockPath), aliasLockPath, "file");
    const lockRoot = await root(directory, { symlinks: "follow-within-root" });
    const contenderPayload = vi.fn(() => ({ owner: "contender" }));
    const contenderRemoval = vi.fn(() => false);
    let contenderFailure: unknown;
    expect(() => acquireFileLockSync(target, {
      ...immediate,
      lockPath: aliasLockPath,
      lockRoot,
      payload: () => ({ owner: "outer" }),
      shouldReclaim: () => true,
      staleRecovery: "remove-if-unchanged",
      shouldRemoveStaleLock: () => {
        try {
          acquireFileLockSync(target, {
            ...immediate,
            lockPath: canonicalLockPath,
            lockRoot,
            payload: contenderPayload,
            shouldReclaim: () => true,
            staleRecovery: "remove-if-unchanged",
            shouldRemoveStaleLock: contenderRemoval,
          });
        } catch (error) {
          contenderFailure = error;
        }
        return false;
      },
    })).toThrow(expect.objectContaining({ code: "file_lock_stale" }));
    expect(contenderFailure).toMatchObject({ code: "file_lock_timeout" });
    expect(contenderPayload).not.toHaveBeenCalled();
    expect(contenderRemoval).not.toHaveBeenCalled();
    expect(fs.readFileSync(canonicalLockPath, "utf8")).toBe("{}");
    expect(fs.lstatSync(aliasLockPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(`${canonicalLockPath}.reclaim`)).toBe(false);
    expect(fs.existsSync(`${aliasLockPath}.reclaim`)).toBe(false);
  });

  itPosix("fails closed when mutation and read admission resolve a sidecar differently", async () => {
    const directory = await tempRoot("fs-safe-sync-root-resolver-disagreement-");
    const actualA = path.join(directory, "actual-a");
    const actualB = path.join(directory, "actual-b");
    const alias = path.join(directory, "alias");
    fs.mkdirSync(actualA);
    fs.mkdirSync(actualB);
    fs.symlinkSync("actual-a", alias, "dir");
    const actualRealpath = canonicalPath.realpathSync;
    let aliasResolutions = 0;
    vi.spyOn(canonicalPath, "realpathSync").mockImplementation((input) => {
      if (input === alias) {
        aliasResolutions += 1;
        return aliasResolutions === 1 ? actualA : actualB;
      }
      return actualRealpath(input);
    });
    const lockRoot = await root(directory, {
      mutationSymlinks: "follow-parents-within-root",
      symlinks: "follow-within-root",
    });
    const payload = vi.fn(() => ({ owner: "test" }));
    expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
      ...immediate,
      lockPath: path.join(alias, "state.lock"),
      lockRoot,
      payload,
    })).toThrow(expect.objectContaining({ code: "path-mismatch" }));
    expect(aliasResolutions).toBe(2);
    expect(payload).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(actualA, "state.lock"))).toBe(false);
    expect(fs.existsSync(path.join(actualB, "state.lock"))).toBe(false);
  });

  itPosix("rejects a dangling final sidecar symlink before payload or target creation", async () => {
    const directory = await tempRoot("fs-safe-sync-root-dangling-final-");
    const lockPath = path.join(directory, "state.lock");
    fs.symlinkSync("missing.lock", lockPath, "file");
    const lockRoot = await root(directory, {
      symlinks: "follow-within-root",
    });
    const payload = vi.fn(() => ({ owner: "test" }));
    const targetParent = path.join(directory, "external", "missing");
    expect(() => acquireFileLockSync(path.join(targetParent, "state.json"), {
      ...immediate,
      lockPath,
      lockRoot,
      payload,
    })).toThrow();
    expect(payload).not.toHaveBeenCalled();
    expect(fs.lstatSync(lockPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(targetParent)).toBe(false);
    expect(fs.existsSync(path.join(directory, "missing.lock"))).toBe(false);
  });
});
