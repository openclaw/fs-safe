import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const immediate = { timeoutMs: 0, retry: { retries: 0 } } as const;

describe("synchronous Root-backed removal authority", () => {
  itPosix("refreshes deny policy for the actual intermediate parent after its callback", async () => {
    const directory = await tempRoot("fs-safe-sync-root-parent-deny-swap-");
    const safe = path.join(directory, "safe");
    const alias = path.join(directory, "policy-alias");
    const firstParent = path.join(directory, "nested");
    const lockPath = path.join(firstParent, "deeper", "state.lock");
    fs.mkdirSync(safe);
    fs.symlinkSync("safe", alias, "dir");
    let assertions = 0;
    let payloads = 0;
    let swapped = false;
    const lockRoot = await root(directory, {
      denyMutations: { paths: [path.join(alias, "nested")] },
      assertBeforeMutation: () => {
        assertions += 1;
        if (assertions !== 2) return;
        fs.unlinkSync(alias);
        fs.symlinkSync(".", alias, "dir");
        swapped = true;
      },
    });
    try {
      expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
        ...immediate,
        lockPath,
        lockRoot,
        payload: () => {
          payloads += 1;
          return { owner: "test" };
        },
      })).toThrow(expect.objectContaining({ code: "denied-path" }));
      expect(assertions).toBe(2);
      expect(payloads).toBe(1);
      expect(fs.existsSync(firstParent)).toBe(false);
    } finally {
      if (swapped) fs.unlinkSync(alias);
    }
  });

  itPosix("refreshes file deny policy after the final mutation callback", async () => {
    const directory = await tempRoot("fs-safe-sync-root-file-deny-swap-");
    const locks = path.join(directory, "locks");
    const safe = path.join(directory, "safe");
    const alias = path.join(directory, "policy-alias");
    fs.mkdirSync(locks);
    fs.mkdirSync(safe);
    fs.symlinkSync("safe", alias, "dir");
    const lockPath = path.join(locks, "state.lock");
    let armed = false;
    let swapped = false;
    const lockRoot = await root(directory, {
      denyMutations: { paths: [path.join(alias, "state.lock")] },
      assertBeforeMutation: () => {
        if (!armed || swapped) return;
        fs.unlinkSync(alias);
        fs.symlinkSync("locks", alias, "dir");
        swapped = true;
      },
    });
    const lock = acquireFileLockSync(path.join(directory, "state.json"), {
      lockPath,
      lockRoot,
      payload: () => ({ owner: "test" }),
    });
    armed = true;
    try {
      expect(() => lock.release()).toThrow(expect.objectContaining({ code: "denied-path" }));
      expect(swapped).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      armed = false;
      if (swapped) fs.unlinkSync(alias);
      lock.release();
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  itPosix("refreshes reclaim-directory deny policy after its mutation callback", async () => {
    const directory = await tempRoot("fs-safe-sync-root-directory-deny-swap-");
    const locks = path.join(directory, "locks");
    const safe = path.join(directory, "safe");
    const alias = path.join(directory, "policy-alias");
    fs.mkdirSync(locks);
    fs.mkdirSync(safe);
    fs.symlinkSync("safe", alias, "dir");
    const lockPath = path.join(locks, "state.lock");
    const guardPath = `${lockPath}.reclaim`;
    fs.writeFileSync(lockPath, "{}");
    let armed = false;
    let swapped = false;
    const lockRoot = await root(directory, {
      denyMutations: {
        paths: [path.join(alias, "state.lock.reclaim", "protected-child")],
      },
      assertBeforeMutation: () => {
        if (!armed || swapped) return;
        fs.unlinkSync(alias);
        fs.symlinkSync("locks", alias, "dir");
        swapped = true;
      },
    });
    try {
      expect(() => acquireFileLockSync(path.join(directory, "state.json"), {
        ...immediate,
        lockPath,
        lockRoot,
        payload: () => ({ owner: "test" }),
        shouldReclaim: () => true,
        staleRecovery: "remove-if-unchanged",
        shouldRemoveStaleLock: () => {
          armed = true;
          return false;
        },
      })).toThrow(expect.objectContaining({ code: "denied-path" }));
      expect(swapped).toBe(true);
      expect(fs.statSync(guardPath).isDirectory()).toBe(true);
      expect(fs.readFileSync(lockPath, "utf8")).toBe("{}");
    } finally {
      armed = false;
      if (swapped) fs.unlinkSync(alias);
      if (fs.existsSync(guardPath)) fs.rmdirSync(guardPath);
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
  });

  it("keeps a stale lock when only its owned reclaim guard is replaced", async () => {
    const directory = await tempRoot("fs-safe-sync-root-guard-only-swap-");
    const lockPath = path.join(directory, "state.lock");
    const guardPath = `${lockPath}.reclaim`;
    const movedGuard = `${guardPath}.moved`;
    fs.writeFileSync(lockPath, "{}");
    let armed = false;
    let swapped = false;
    const lockRoot = await root(directory, {
      assertBeforeMutation: () => {
        if (!armed || swapped) return;
        fs.renameSync(guardPath, movedGuard);
        fs.mkdirSync(guardPath);
        swapped = true;
      },
    });
    let failure: unknown;
    try {
      acquireFileLockSync(path.join(directory, "state.json"), {
        ...immediate,
        lockPath,
        lockRoot,
        payload: () => ({ owner: "test" }),
        shouldReclaim: () => true,
        staleRecovery: "remove-if-unchanged",
        shouldRemoveStaleLock: () => {
          armed = true;
          return true;
        },
      });
    } catch (error) {
      failure = error;
    }
    try {
      expect(failure).toMatchObject({
        name: "SuppressedError",
        error: expect.objectContaining({ code: "path-mismatch" }),
        suppressed: expect.objectContaining({ code: "path-mismatch" }),
      });
      expect(swapped).toBe(true);
      expect(fs.readFileSync(lockPath, "utf8")).toBe("{}");
      expect(fs.statSync(guardPath).isDirectory()).toBe(true);
      expect(fs.statSync(movedGuard).isDirectory()).toBe(true);
    } finally {
      if (fs.existsSync(guardPath)) fs.rmdirSync(guardPath);
      if (fs.existsSync(movedGuard)) fs.rmdirSync(movedGuard);
      if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
  });
});
