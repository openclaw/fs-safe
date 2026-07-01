/**
 * Tests for renameIdentity: "verify-content-with-lock" — the opt-in that allows
 * fs-safe writes to succeed on FUSE mounts (e.g. rclone) where rename(2) causes
 * every subsequent path-based lookup to return a freshly-minted inode, making the
 * post-rename (dev,ino) identity check always fail even with zero concurrency.
 *
 * Pre-change tests (A, D) document the existing throwing behavior and must pass
 * before and after this fix.  Post-change tests (B, C) are the expected new
 * behavior after the fix and will fail until the implementation lands.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafePython, root as openRoot } from "../src/index.js";
import { __resetPinnedPythonWorkerForTest } from "../src/pinned-python.js";

const tempDirs: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Simulates FUSE-style inode churn where rename(2) on targetPath causes the
 * *very next* path-based lstat of that path to return a freshly-minted inode
 * different from the pre-rename fd-based stat, while all subsequent lstat
 * calls (including those inside openVerifiedLocalFile and verifyAtomicWriteResult)
 * return normal, consistent values.
 *
 * Returns an object with a `trackRename()` callback that the caller's rename
 * mock must invoke after each rename to targetPath, and an optional
 * `withAttackerOverwrite(fn)` wrapper for constructing the rename mock in
 * tests that also need to simulate an attacker overwriting the target.
 *
 * This matches the observed rclone behaviour from our live probe:
 *   pre-rename fd-stat   ino=X
 *   post-rename lstat[0] ino=Y  (different — triggers the bug)
 *   post-rename lstat[1] ino=Y  (same new stable value — subsequent checks pass)
 */
function simulateFuseInodeChurnOnTarget(targetPath: string): {
  trackRename(): void;
} {
  let interceptsRemaining = 0;

  const realLstat = fsp.lstat.bind(fsp);
  vi.spyOn(fsp, "lstat").mockImplementation(async (p, opts?) => {
    const stat = await realLstat(p as string, opts as never);
    if (p === targetPath && interceptsRemaining > 0) {
      interceptsRemaining--;
      const fakeIno =
        typeof stat.ino === "bigint"
          ? stat.ino + BigInt("9999999000000000000")
          : stat.ino + 9_999_999;
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        ino: fakeIno,
      });
    }
    return stat;
  });

  return {
    trackRename(): void {
      interceptsRemaining++;
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  __resetPinnedPythonWorkerForTest();
  configureFsSafePython({ mode: "auto", pythonPath: undefined });
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe("rename identity policy (FUSE inode churn)", () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Test A — PRE-CHANGE BASELINE.
  // Default strict mode throws path-mismatch when inode changes after rename.
  // Must pass both BEFORE and AFTER the fix.
  // ─────────────────────────────────────────────────────────────────────────
  it.runIf(process.platform !== "win32")(
    "A: strict mode (default) throws path-mismatch when inode changes after rename",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-strict-");
      const targetPath = path.join(rootDir, "file.txt");
      const churn = simulateFuseInodeChurnOnTarget(targetPath);
      const realRename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        await realRename(from as string, to as string);
        if (to === targetPath) churn.trackRename();
      });

      const fs = await openRoot(rootDir);
      await expect(fs.write("file.txt", "hello")).rejects.toMatchObject({
        code: "path-mismatch",
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Test B — POST-CHANGE SUCCESS.
  // verify-content-with-lock mode succeeds on simulated FUSE inode churn.
  // Fails before the fix; must pass after.
  // ─────────────────────────────────────────────────────────────────────────
  it.runIf(process.platform !== "win32")(
    "B: verify-content-with-lock succeeds when inode changes after rename but content matches",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-lock-");
      const targetPath = path.join(rootDir, "file.txt");
      const churn = simulateFuseInodeChurnOnTarget(targetPath);
      const realRename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        await realRename(from as string, to as string);
        if (to === targetPath) churn.trackRename();
      });

      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      await expect(fs.write("file.txt", "hello")).resolves.toBeUndefined();

      // Content must be exactly what was written.
      await expect(fsp.readFile(targetPath, "utf8")).resolves.toBe("hello");

      // Lock sidecar must be released after the operation.
      await expect(fsp.stat(`${targetPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Test C — ATTACKER CONTENT REJECTED.
  // Even with verify-content-with-lock, if a non-cooperating process overwrites
  // the target (between our rename and our content-read) with different bytes,
  // the write throws path-mismatch rather than silently accepting tampered data.
  // Fails before the fix; must pass after.
  // ─────────────────────────────────────────────────────────────────────────
  it.runIf(process.platform !== "win32")(
    "C: verify-content-with-lock throws path-mismatch when content is replaced after rename",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-attack-");
      const targetPath = path.join(rootDir, "file.txt");
      const churn = simulateFuseInodeChurnOnTarget(targetPath);

      // Simulate an out-of-lock attacker that overwrites targetPath with
      // different bytes immediately after every rename completes.
      const realRename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        await realRename(from as string, to as string);
        if (to === targetPath) {
          churn.trackRename();
          await fsp.writeFile(to as string, "attacker-content");
        }
      });

      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      await expect(fs.write("file.txt", "hello")).rejects.toMatchObject({
        code: "path-mismatch",
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Test D — PER-CALL OVERRIDE.
  // renameIdentity can be set per write() call, overriding the root default.
  // Fails before the fix; must pass after.
  // ─────────────────────────────────────────────────────────────────────────
  it.runIf(process.platform !== "win32")(
    "D: renameIdentity can be overridden per write call",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-percall-");

      // Root has strict default (no renameIdentity set).
      const strictRoot = await openRoot(rootDir);
      const strictTarget = path.join(rootDir, "strict.txt");
      const churn = simulateFuseInodeChurnOnTarget(strictTarget);
      const realRename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        await realRename(from as string, to as string);
        if (to === strictTarget) churn.trackRename();
      });

      // Per-call opt-in should succeed even on a strictly-configured root.
      await expect(
        strictRoot.write("strict.txt", "per-call", {
          renameIdentity: "verify-content-with-lock",
        }),
      ).resolves.toBeUndefined();

      await expect(fsp.readFile(strictTarget, "utf8")).resolves.toBe("per-call");
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Test F — STALE LOCK RECOVERY.
  // A lock file left behind by a dead process (e.g. SIGKILL) must be
  // detected via PID-liveness check and removed so the write proceeds,
  // rather than blocking indefinitely or failing with a timeout error.
  // ─────────────────────────────────────────────────────────────────────────
  it.runIf(process.platform !== "win32")(
    "F: stale lock from dead process is reclaimed automatically",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-stale-");
      const targetPath = path.join(rootDir, "file.txt");
      const lockPath = `${targetPath}.lock`;

      // Write a stale lock claiming a PID that definitely does not exist.
      // Linux PIDs are capped at ~4 million; 9_999_999 is always invalid.
      const deadPid = 9_999_999;
      await fsp.writeFile(
        lockPath,
        JSON.stringify({ pid: deadPid, createdAt: new Date(Date.now() - 60_000).toISOString() }) + "\n",
      );

      const churn = simulateFuseInodeChurnOnTarget(targetPath);
      const realRename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        await realRename(from as string, to as string);
        if (to === targetPath) churn.trackRename();
      });

      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      await expect(fs.write("file.txt", "hello")).resolves.toBeUndefined();

      await expect(fsp.readFile(targetPath, "utf8")).resolves.toBe("hello");
      await expect(fsp.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Test G — UNKNOWN-PID LOCK IS NOT AGGRESSIVELY RECLAIMED.
  // A lock file whose payload carries no recognisable PID (corrupted, foreign
  // software) must not be immediately removed; the write must fail rather
  // than silently deleting a lock we cannot verify.
  // ─────────────────────────────────────────────────────────────────────────
  it.runIf(process.platform !== "win32")(
    "G: lock with no valid PID is not aggressively reclaimed",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-nopid-");
      const targetPath = path.join(rootDir, "file.txt");
      const lockPath = `${targetPath}.lock`;

      // Lock payload with no pid field — simulates a corrupted or foreign lock.
      await fsp.writeFile(
        lockPath,
        JSON.stringify({ createdAt: new Date().toISOString() }) + "\n",
      );

      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      // Should not succeed — the lock cannot be identified as stale, so the
      // write must exhaust retries and fail rather than removing the lock.
      await expect(fs.write("file.txt", "hello")).rejects.toBeTruthy();

      // The lock file must still exist — it was not removed.
      await expect(fsp.stat(lockPath)).resolves.toBeTruthy();
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Test E — WORKS ON NORMAL POSIX DISK.
  // With verify-content-with-lock set, a write on a normal filesystem (where
  // rename preserves inodes) acquires the sidecar lock, writes, verifies
  // by content hash, releases the lock, and produces correct output.
  // ─────────────────────────────────────────────────────────────────────────
  it.runIf(process.platform !== "win32")(
    "E: verify-content-with-lock succeeds on a normal POSIX disk and releases its lock",
    async () => {
      configureFsSafePython({ mode: "off" });
      const rootDir = await makeTempRoot("fs-safe-rename-id-posix-");

      // No lstat mock — real inodes are stable on a local tmpfs/ext4.
      const fs = await openRoot(rootDir, { renameIdentity: "verify-content-with-lock" });
      await expect(fs.write("file.txt", "content")).resolves.toBeUndefined();

      await expect(fsp.readFile(path.join(rootDir, "file.txt"), "utf8")).resolves.toBe(
        "content",
      );
      // Lock is acquired then released; the sidecar file must not remain.
      await expect(
        fsp.stat(path.join(rootDir, "file.txt.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
