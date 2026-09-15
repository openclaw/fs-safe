import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, expect } from "vitest";

const write = fs.writeFile;
const remove = fs.rm;
const writes: Promise<void>[] = [];
let directory: string | undefined;
let startedAt: number | undefined;
let settledAt = 0;
let pending = 0;
let completed = 0;
let removals = 0;
let raced = false;

// Direct wrappers survive the test file's afterEach(vi.restoreAllMocks).
fs.writeFile = (target, data, options) => {
  if (typeof target !== "string" || !path.basename(path.dirname(target)).startsWith("fs-safe-walk-timer-")) {
    return write(target, data, options);
  }
  directory = path.dirname(target);
  startedAt ??= performance.now();
  pending++;
  const operation = (async () => {
    try {
      // Delay the real fixture work beyond the unchanged five-second test limit.
      await delay(6_000);
      await write(target, data, options);
      completed++;
    } finally {
      pending--;
      settledAt = performance.now();
    }
  })();
  writes.push(operation);
  return operation;
};

fs.rm = async (target, options) => {
  if (target === directory) raced ||= pending !== 0;
  await remove(target, options);
  if (target === directory) removals++;
};

afterAll(async () => {
  try {
    // Drain even a broken baseline before checking and removing its leftovers.
    await Promise.allSettled(writes);
    const setupMs = settledAt - (startedAt ?? settledAt);
    console.log(JSON.stringify({ slowWalkFixture: { writes: writes.length, completed, setupMs, removals, teardownRacedWrites: raced } }));
    expect(writes).toHaveLength(256);
    expect(completed).toBe(256);
    expect(setupMs).toBeGreaterThan(5_000);
    expect(removals).toBe(1);
    expect(raced).toBe(false);
    await expect(fs.lstat(directory!)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    fs.writeFile = write;
    fs.rm = remove;
    if (directory) await remove(directory, { recursive: true, force: true });
  }
}, 30_000);
