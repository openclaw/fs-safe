import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquireFileLock, acquireFileLockSync } from "../src/file-lock.js";
import type { SidecarLockRetryOptions } from "../src/sidecar-lock.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

const invalidRetries: Array<{ label: string; retry: SidecarLockRetryOptions }> = [
  { label: "negative retries", retry: { retries: -1 } },
  { label: "fractional retries", retry: { retries: 1.5 } },
  { label: "infinite retries", retry: { retries: Infinity } },
  { label: "negative factor", retry: { factor: -1 } },
  { label: "NaN factor", retry: { factor: Number.NaN } },
  { label: "infinite factor", retry: { factor: Infinity } },
  { label: "negative minimum", retry: { minTimeout: -1 } },
  { label: "NaN minimum", retry: { minTimeout: Number.NaN } },
  { label: "infinite minimum", retry: { minTimeout: Infinity } },
  { label: "negative maximum", retry: { maxTimeout: -1 } },
  { label: "NaN maximum", retry: { maxTimeout: Number.NaN } },
  { label: "infinite maximum", retry: { maxTimeout: Infinity } },
  { label: "inverted range", retry: { minTimeout: 2, maxTimeout: 1 } },
];

describe("file-lock retry validation", () => {
  it.each(invalidRetries)("rejects $label before async or sync acquisition", async ({ retry }) => {
    const directory = await tempRoot("fs-safe-lock-retry-invalid-");
    const asyncTarget = path.join(directory, "async.json");
    const syncTarget = path.join(directory, "sync.json");
    const asyncPayload = vi.fn(async () => ({}));
    const syncPayload = vi.fn(() => ({}));

    await expect(acquireFileLock(asyncTarget, { payload: asyncPayload, retry })).rejects.toThrow(
      RangeError,
    );
    expect(() => acquireFileLockSync(syncTarget, { payload: syncPayload, retry })).toThrow(
      RangeError,
    );
    expect(asyncPayload).not.toHaveBeenCalled();
    expect(syncPayload).not.toHaveBeenCalled();
    await expect(fs.access(`${asyncTarget}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(`${syncTarget}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([Number.NaN, Number.NEGATIVE_INFINITY, -1])(
    "rejects invalid timeout %s before acquisition",
    async (timeoutMs) => {
      const directory = await tempRoot("fs-safe-lock-timeout-invalid-");
      const asyncTarget = path.join(directory, "async.json");
      const syncTarget = path.join(directory, "sync.json");

      await expect(
        acquireFileLock(asyncTarget, { payload: async () => ({}), timeoutMs }),
      ).rejects.toThrow(RangeError);
      expect(() =>
        acquireFileLockSync(syncTarget, { payload: () => ({}), timeoutMs }),
      ).toThrow(RangeError);
    },
  );
});
