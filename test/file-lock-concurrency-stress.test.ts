import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock, acquireFileLockSync, withFileLock } from "../src/file-lock.js";
import { createSidecarLockManager } from "../src/sidecar-lock.js";

const childTarget = process.env.FS_SAFE_STRESS_LOCK_TARGET;
const childLog = process.env.FS_SAFE_STRESS_LOCK_LOG;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

describe("file-lock concurrency stress", () => {
  it.runIf(!childTarget)("bounds attacker-controlled sidecar payload reads", async () => {
    const base = await tempRoot("fs-safe-sidecar-payload-limit-");
    const targetPath = path.join(base, "state.json");
    const lockPath = `${targetPath}.lock`;
    await fs.writeFile(lockPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const manager = createSidecarLockManager(`fs-safe-payload-limit-${Date.now()}`);

    await expect(
      manager.acquire({
        targetPath,
        lockPath,
        staleMs: 1,
        timeoutMs: 0,
        retry: { retries: 0 },
        payload: async () => ({ createdAt: new Date().toISOString() }),
      }),
    ).rejects.toMatchObject({ code: "too-large" });
    expect(() =>
      acquireFileLockSync(targetPath, {
        staleMs: 1,
        timeoutMs: 0,
        retry: { retries: 0 },
        payload: () => ({ createdAt: new Date().toISOString() }),
      }),
    ).toThrow(expect.objectContaining({ code: "too-large" }));
  });

  it.runIf(!childTarget && process.platform !== "win32")(
    "rejects a dangling symlink sidecar without ignoring the deadline",
    async () => {
      const base = await tempRoot("fs-safe-sidecar-dangling-symlink-");
      const targetPath = path.join(base, "state.json");
      await fs.symlink(path.join(base, "missing"), `${targetPath}.lock`);

      await expect(
        acquireFileLock(targetPath, {
          staleMs: 1,
          timeoutMs: 0,
          retry: { retries: 0 },
          payload: async () => ({ createdAt: new Date().toISOString() }),
        }),
      ).rejects.toMatchObject({ code: "not-file" });
      expect(() =>
        acquireFileLockSync(targetPath, {
          staleMs: 1,
          timeoutMs: 0,
          retry: { retries: 0 },
          payload: () => ({ createdAt: new Date().toISOString() }),
        }),
      ).toThrow(expect.objectContaining({ code: "not-file" }));
    },
  );

  it.runIf(!childTarget)("never overlaps many in-process holders and releases after throws", async () => {
    const root = await tempRoot("fs-safe-lock-in-process-");
    const targetPath = path.join(root, "state.json");
    let active = 0;
    let peak = 0;

    const results = await Promise.allSettled(
      Array.from({ length: 40 }, async (_, index) => {
        return await withFileLock(
          targetPath,
          {
            staleMs: 60_000,
            timeoutMs: 10_000,
            retry: { minTimeout: 1, maxTimeout: 2 },
            payload: async () => ({ index, createdAt: new Date().toISOString() }),
          },
          async () => {
            active += 1;
            peak = Math.max(peak, active);
            try {
              await delay(index % 3);
              if (index % 11 === 0) throw new Error(`holder ${index} failed`);
              return index;
            } finally {
              active -= 1;
            }
          },
        );
      }),
    );

    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(4);
    await expect(fs.stat(`${targetPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(!childTarget)(
    "never overlaps holders across real child processes",
    async () => {
      const root = await tempRoot("fs-safe-lock-child-process-");
      const targetPath = path.join(root, "state.json");
      const logPath = path.join(root, "critical-sections.log");
      const vitestPath = path.resolve("node_modules/vitest/vitest.mjs");
      const testPath = path.relative(process.cwd(), import.meta.filename);

      const children = Array.from({ length: 8 }, (_, index) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [vitestPath, "run", testPath, "--maxWorkers=1", "--silent"],
            {
              env: {
                ...process.env,
                FS_SAFE_STRESS_LOCK_TARGET: targetPath,
                FS_SAFE_STRESS_LOCK_LOG: logPath,
                FS_SAFE_STRESS_LOCK_INDEX: String(index),
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
          });
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`lock child ${index} exited ${code}: ${stderr}`));
          });
        }),
      );
      await Promise.all(children);

      const events = (await fs.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.split(" "));
      const active = new Set<string>();
      let peak = 0;
      for (const [event, owner] of events) {
        if (event === "enter") {
          active.add(owner!);
          peak = Math.max(peak, active.size);
        } else {
          active.delete(owner!);
        }
      }
      expect(events).toHaveLength(16);
      expect(peak).toBe(1);
      expect(active.size).toBe(0);
      await expect(fs.stat(`${targetPath}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    },
    20_000,
  );

  it.runIf(!!childTarget)("holds one cross-process critical section", async () => {
    const owner = `${process.pid}:${process.env.FS_SAFE_STRESS_LOCK_INDEX ?? "unknown"}`;
    const lock = await acquireFileLock(childTarget!, {
      staleMs: 60_000,
      timeoutMs: 10_000,
      retry: { minTimeout: 1, maxTimeout: 5 },
      payload: async () => ({ owner, createdAt: new Date().toISOString() }),
    });
    try {
      await fs.appendFile(childLog!, `enter ${owner}\n`);
      await delay(20);
      await fs.appendFile(childLog!, `exit ${owner}\n`);
    } finally {
      await lock.release();
    }
    expect(await fs.readFile(childLog!, "utf8")).toContain(owner);
  });
});
