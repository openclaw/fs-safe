import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync } from "../src/file-lock.js";
import { root } from "../src/root.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const now = Date.parse("2026-01-01T00:00:00.000Z");
const payload = () => ({ pid: process.pid });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("synchronous file-lock snapshot age", () => {
  it.each(["missing", "malformed"])(
    "retries a holder's unlink after reading a snapshot with %s createdAt",
    async (timestamp) => {
      const targetPath = path.join(await tempRoot("fs-safe-sync-age-unlink-"), "state.json");
      const lockPath = `${targetPath}.lock`;
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ...(timestamp === "malformed" ? { createdAt: "invalid" } : {}) }));
      fs.utimesSync(lockPath, now / 1000, now / 1000);
      vi.spyOn(Date, "now").mockReturnValue(now);
      const parsePayload = vi.fn((raw: string) => {
        // Parsing runs after the snapshot's final identity/mtime observation.
        fs.unlinkSync(lockPath);
        return JSON.parse(raw);
      });
      const lock = acquireFileLockSync(targetPath, {
        payload,
        parsePayload,
        staleMs: 60_000,
        timeoutMs: 5_000,
        retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
      });
      try {
        expect(parsePayload).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(payload());
      } finally {
        lock.release();
      }
      expect(fs.existsSync(lockPath)).toBe(false);
    },
  );

  itPosix("retries the same snapshot/unlink handoff with lockRoot", async () => {
    const directory = await tempRoot("fs-safe-sync-age-root-");
    const lockRoot = await root(directory);
    const targetPath = path.join(directory, "state.json");
    const lockPath = `${targetPath}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify(payload()));
    fs.utimesSync(lockPath, now / 1000, now / 1000);
    vi.spyOn(Date, "now").mockReturnValue(now);
    const lock = acquireFileLockSync(targetPath, {
      lockRoot,
      payload,
      staleMs: 60_000,
      retry: { retries: 1, minTimeout: 0, maxTimeout: 0 },
      parsePayload: (raw) => {
        fs.unlinkSync(lockPath);
        return JSON.parse(raw);
      },
    });
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("does not combine a fresh snapshot with a replacement's older mtime", async () => {
    const targetPath = path.join(await tempRoot("fs-safe-sync-age-replace-"), "state.json");
    const lockPath = `${targetPath}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify(payload()));
    fs.utimesSync(lockPath, now / 1000, now / 1000);
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(() => acquireFileLockSync(targetPath, {
      payload,
      staleMs: 60_000,
      retry: { retries: 0 },
      parsePayload: (raw) => {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, "replacement");
        fs.utimesSync(lockPath, 0, 0);
        return JSON.parse(raw);
      },
    })).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    expect(fs.readFileSync(lockPath, "utf8")).toBe("replacement");
  });

  it.each(["missing", "malformed"])("recovers an approved old mtime with %s createdAt", async (timestamp) => {
    const targetPath = path.join(await tempRoot("fs-safe-sync-age-recover-"), "state.json");
    const lockPath = `${targetPath}.lock`;
    const raw = JSON.stringify({ pid: process.pid, ...(timestamp === "malformed" ? { createdAt: "invalid" } : {}) });
    fs.writeFileSync(lockPath, raw);
    fs.utimesSync(lockPath, 0, 0);
    const options = { payload, staleMs: 60_000, retry: { retries: 0 } };
    expect(() => acquireFileLockSync(targetPath, options))
      .toThrow(expect.objectContaining({ code: "file_lock_stale" }));
    const approve = vi.fn((snapshot: { raw: string }) => snapshot.raw === raw);
    const lock = acquireFileLockSync(targetPath, {
      ...options,
      staleRecovery: "remove-if-unchanged",
      shouldRemoveStaleLock: approve,
    });
    try {
      expect(approve).toHaveBeenCalledTimes(1);
      expect(lock.verifyStillHeld()).toBe(true);
    } finally {
      lock.release();
    }
    expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
