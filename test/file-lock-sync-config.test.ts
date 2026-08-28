import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireFileLockSync, withFileLockSync } from "../src/file-lock.js";
import { configureFsSafeLocks, getFsSafeLockConfig } from "../src/config.js";
import * as timing from "../src/timing.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const now = Date.parse("2026-01-01T00:00:00.000Z");
const payload = () => ({ createdAt: new Date(now).toISOString(), owner: "new" });
let savedConfig: ReturnType<typeof getFsSafeLockConfig>;
let elapsed: number;
let delays: number[];

beforeEach(() => {
  savedConfig = getFsSafeLockConfig();
  configureFsSafeLocks({
    retry: undefined,
    staleMs: undefined,
    staleRecovery: "fail-closed",
    timeoutMs: undefined,
  });
  elapsed = 0;
  delays = [];
  vi.spyOn(Date, "now").mockImplementation(() => now + elapsed);
  vi.spyOn(timing, "sleepSync").mockImplementation((ms) => {
    // A synchronous regression cannot be interrupted by Vitest's test timeout.
    if (delays.length >= 12) throw new Error("synchronous retry escape reached");
    delays.push(ms);
    elapsed += Math.max(1, ms);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeLocks({
    retry: undefined,
    staleMs: undefined,
    timeoutMs: undefined,
    ...savedConfig,
  });
});

async function fixture(ageMs = 0) {
  const targetPath = path.join(await tempRoot("fs-safe-sync-config-"), "state.json");
  const lockPath = `${targetPath}.lock`;
  const raw = JSON.stringify({ createdAt: new Date(now - ageMs).toISOString(), owner: "old" });
  fs.writeFileSync(lockPath, raw);
  return { targetPath, lockPath, raw };
}

describe("synchronous file-lock process defaults", () => {
  it.each(["sidecar", "held", "reclaim guard", "withFileLockSync"])(
    "bounds %s contention using only the configured timeout",
    async (contention) => {
      const { targetPath, lockPath, raw } = await fixture();
      let held: ReturnType<typeof acquireFileLockSync> | undefined;
      if (contention === "held") {
        fs.unlinkSync(lockPath);
        held = acquireFileLockSync(targetPath, { payload });
      } else if (contention === "reclaim guard") {
        fs.mkdirSync(`${lockPath}.reclaim`);
      }
      configureFsSafeLocks({ timeoutMs: 20 });
      const work = vi.fn();
      try {
        expect(() => {
          if (contention === "withFileLockSync") {
            withFileLockSync(targetPath, { payload }, work);
          } else {
            acquireFileLockSync(targetPath, { payload });
          }
        }).toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
        // Keep the existing sync behavior: sleeps are not clamped to the deadline.
        expect(delays).toEqual([50]);
        expect(work).not.toHaveBeenCalled();
        if (held) expect(held.verifyStillHeld()).toBe(true);
        else expect(fs.readFileSync(lockPath, "utf8")).toBe(raw);
        if (contention === "reclaim guard") expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(true);
      } finally {
        held?.release();
      }
    },
  );

  it.each([
    { configured: 0, perCall: undefined, expectedDelays: [] },
    { configured: 100, perCall: 0, expectedDelays: [] },
    { configured: 0, perCall: 20, expectedDelays: [50] },
  ])("resolves timeout $configured with per-call $perCall", async ({ configured, perCall, expectedDelays }) => {
    const { targetPath } = await fixture();
    configureFsSafeLocks({ timeoutMs: configured });
    expect(() => acquireFileLockSync(targetPath, { payload, timeoutMs: perCall }))
      .toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    expect(delays).toEqual(expectedDelays);
  });

  it.each([0, 2])("honors configured retry budget %s without a per-call deadline", async (retries) => {
    const { targetPath } = await fixture();
    configureFsSafeLocks({ retry: { retries } });
    const attemptedPayload = vi.fn(payload);
    expect(() => acquireFileLockSync(targetPath, { payload: attemptedPayload }))
      .toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    expect(attemptedPayload).toHaveBeenCalledTimes(retries + 1);
    expect(delays).toEqual(Array(retries).fill(50));
  });

  it("uses configured backoff and jitter fields", async () => {
    const { targetPath } = await fixture();
    configureFsSafeLocks({ retry: { retries: 3, minTimeout: 4, maxTimeout: 10, factor: 2, randomize: true } });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(() => acquireFileLockSync(targetPath, { payload }))
      .toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    expect(delays).toEqual([6, 10, 10]);
  });

  it.each([
    { retry: { retries: 2 }, expectedDelays: [50, 50] },
    { retry: {}, expectedDelays: [50, 50, 50] },
    { retry: { retries: 0 }, expectedDelays: [] },
    { retry: { retries: 2, minTimeout: 0, maxTimeout: 0, factor: 0, randomize: false }, expectedDelays: [0, 0] },
  ])("replaces the entire configured retry object with $retry", async ({ retry, expectedDelays }) => {
    const { targetPath } = await fixture();
    configureFsSafeLocks({
      timeoutMs: 125,
      retry: { retries: 1, minTimeout: 7, maxTimeout: 10, factor: 4, randomize: true },
    });
    const random = vi.spyOn(Math, "random");
    expect(() => acquireFileLockSync(targetPath, { payload, retry }))
      .toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    expect(delays).toEqual(expectedDelays);
    expect(random).not.toHaveBeenCalled();
  });

  it("retains the synchronous retry cap with a configured infinite timeout", async () => {
    const { targetPath } = await fixture();
    configureFsSafeLocks({ timeoutMs: Infinity, retry: { retries: 1 } });
    expect(() => acquireFileLockSync(targetPath, { payload }))
      .toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    expect(delays).toEqual([50]);
  });

  it.each([
    { configured: 1_000, perCall: undefined, code: "file_lock_stale" },
    { configured: 0, perCall: undefined, code: "file_lock_stale" },
    { configured: 10_000, perCall: 0, code: "file_lock_stale" },
    { configured: 0, perCall: 10_000, code: "file_lock_timeout" },
  ])("resolves stale age $configured with per-call $perCall", async ({ configured, perCall, code }) => {
    const { targetPath, lockPath, raw } = await fixture(5_000);
    configureFsSafeLocks({ staleMs: configured });
    expect(() => acquireFileLockSync(targetPath, { payload, staleMs: perCall, retry: { retries: 0 } }))
      .toThrow(expect.objectContaining({ code }));
    expect(fs.readFileSync(lockPath, "utf8")).toBe(raw);
  });

  it("passes the resolved stale threshold to the caller's reclaim policy", async () => {
    const { targetPath } = await fixture();
    configureFsSafeLocks({ staleMs: 123, retry: { retries: 0 } });
    const shouldReclaim = vi.fn(() => false);
    expect(() => acquireFileLockSync(targetPath, { payload, shouldReclaim }))
      .toThrow(expect.objectContaining({ code: "file_lock_timeout" }));
    expect(shouldReclaim).toHaveBeenCalledWith(expect.objectContaining({ staleMs: 123, nowMs: now }));
  });

  it.each(["acquire", "withFileLockSync"])("applies configured stale age and approved recovery through %s", async (entrypoint) => {
    const { targetPath, lockPath, raw } = await fixture(5_000);
    configureFsSafeLocks({ staleMs: 1_000, staleRecovery: "remove-if-unchanged", retry: { retries: 0 } });
    const approve = vi.fn((snapshot: { raw: string }) => snapshot.raw === raw);
    const options = { payload, shouldRemoveStaleLock: approve };
    if (entrypoint === "withFileLockSync") {
      expect(withFileLockSync(targetPath, options, () => {
        expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(payload());
        return "protected result";
      })).toBe("protected result");
    } else {
      const lock = acquireFileLockSync(targetPath, options);
      try {
        expect(lock.verifyStillHeld()).toBe(true);
      } finally {
        lock.release();
      }
    }
    expect(approve).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it.each(["missing", "false", "per-call fail-closed"])("preserves stale sidecars with %s approval", async (approval) => {
    const { targetPath, lockPath, raw } = await fixture(60_000);
    configureFsSafeLocks({ staleRecovery: "remove-if-unchanged", retry: { retries: 0 } });
    const approve = vi.fn(() => approval !== "false");
    expect(() => acquireFileLockSync(targetPath, {
      payload,
      shouldRemoveStaleLock: approval === "missing" ? undefined : approve,
      staleRecovery: approval === "per-call fail-closed" ? "fail-closed" : undefined,
    })).toThrow(expect.objectContaining({ code: "file_lock_stale" }));
    expect(approve).toHaveBeenCalledTimes(approval === "false" ? 1 : 0);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(raw);
    expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
  });

  it("allows per-call approved recovery to override configured fail-closed", async () => {
    const { targetPath, lockPath } = await fixture(60_000);
    configureFsSafeLocks({ staleRecovery: "fail-closed", retry: { retries: 0 } });
    expect(() => withFileLockSync(targetPath, {
      payload,
      staleRecovery: "remove-if-unchanged",
      shouldRemoveStaleLock: () => true,
    }, () => { throw new Error("protected work failed"); })).toThrow("protected work failed");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("preserves a replacement made during globally enabled recovery approval", async () => {
    const { targetPath, lockPath } = await fixture(60_000);
    configureFsSafeLocks({ staleRecovery: "remove-if-unchanged", retry: { retries: 0 } });
    const replacement = JSON.stringify(payload());
    expect(() => acquireFileLockSync(targetPath, {
      payload,
      shouldRemoveStaleLock: () => {
        fs.writeFileSync(lockPath, replacement);
        return true;
      },
    })).toThrow(expect.objectContaining({ code: "file_lock_stale" }));
    expect(fs.readFileSync(lockPath, "utf8")).toBe(replacement);
    expect(fs.existsSync(`${lockPath}.reclaim`)).toBe(false);
  });
});
