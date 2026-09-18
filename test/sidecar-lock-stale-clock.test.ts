import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

it.each([false, true].flatMap(rooted => [false, true].map(custom => ({ rooted, custom }))))(
  "evaluates stale age after snapshot parsing (Root=$rooted custom=$custom)",
  async ({ rooted, custom }) => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-stale-clock-");
    const lockRoot = rooted ? await root(directory) : undefined;
    const targetPath = path.join(directory, "state");
    const lockPath = `${targetPath}.lock`;
    const epoch = Date.parse("2026-01-01T00:00:00Z");
    await fs.writeFile(lockPath, JSON.stringify({ createdAt: new Date(epoch).toISOString() }));
    const clock = vi.spyOn(Date, "now").mockReturnValue(epoch + 4);
    const seen: number[] = [];
    const manager = createSidecarLockManager(directory);
    const held = await manager.acquire({
      targetPath, lockPath, lockRoot, staleMs: 5, timeoutMs: 1000,
      retry: { retries: 0, minTimeout: 0, maxTimeout: 0 },
      payload: async () => ({ owner: "new" }),
      parsePayload(raw) {
        clock.mockReturnValue(epoch + 10);
        return JSON.parse(raw);
      },
      ...(custom ? { shouldReclaim({ nowMs, staleMs }: { nowMs: number; staleMs: number }) {
        seen.push(nowMs);
        return nowMs - epoch > staleMs;
      } } : {}),
      staleRecovery: "remove-if-unchanged",
      shouldRemoveStaleLock: () => true,
    });
    try {
      expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toEqual({ owner: "new" });
      if (custom) expect(seen).toEqual([epoch + 10]);
    } finally {
      await held.release();
    }
  },
);
