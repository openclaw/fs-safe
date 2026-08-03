import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itPosix } from "./helpers/vitest.js";
import {
  ackJsonDurableQueueEntry,
  ensureJsonDurableQueueDirs,
  jsonDurableQueueEntryExists,
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  moveJsonDurableQueueEntryToFailed,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
} from "../src/json-durable-queue.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-json-queue-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("durable JSON queues", () => {
  it("writes, migrates, loads, acks, and moves entries", async () => {
    const queueDir = path.join(root, "queue");
    const failedDir = path.join(root, "failed");
    await ensureJsonDurableQueueDirs({ queueDir, failedDir });

    const paths = resolveJsonDurableQueueEntryPaths(queueDir, "entry-1");
    await writeJsonDurableQueueEntry({
      filePath: paths.jsonPath,
      entry: { id: "entry-1", version: 1 },
      tempPrefix: "queue",
    });

    await expect(jsonDurableQueueEntryExists(paths.jsonPath)).resolves.toBe(true);
    await expect(
      loadJsonDurableQueueEntry<{ id: string; version: number }>({
        paths,
        tempPrefix: "queue",
        read: async (entry) => ({ entry: { ...entry, version: 2 }, migrated: true }),
      }),
    ).resolves.toEqual({ id: "entry-1", version: 2 });
    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toContain("\"version\": 2");

    await expect(
      loadPendingJsonDurableQueueEntries<{ id: string; version: number }>({
        queueDir,
        tempPrefix: "queue",
      }),
    ).resolves.toEqual([{ id: "entry-1", version: 2 }]);

    await ackJsonDurableQueueEntry(paths);
    await expect(jsonDurableQueueEntryExists(paths.jsonPath)).resolves.toBe(false);

    await writeJsonDurableQueueEntry({
      filePath: paths.jsonPath,
      entry: { id: "entry-1", version: 3 },
      tempPrefix: "queue",
    });
    await moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "entry-1" });
    await expect(fs.readFile(path.join(failedDir, "entry-1.json"), "utf8")).resolves.toContain(
      "\"version\": 3",
    );
  });

  it("skips bad pending entries and cleans stale temp files", async () => {
    const queueDir = path.join(root, "queue");
    const failedDir = path.join(root, "failed");
    await ensureJsonDurableQueueDirs({ queueDir, failedDir });
    await fs.writeFile(path.join(queueDir, "good.json"), JSON.stringify({ ok: true }), "utf8");
    await fs.writeFile(path.join(queueDir, "bad.json"), "{", "utf8");
    const tempPath = path.join(queueDir, "orphan.tmp");
    await fs.writeFile(tempPath, "tmp", "utf8");
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(tempPath, old, old);

    await expect(
      loadPendingJsonDurableQueueEntries<{ ok: boolean }>({
        queueDir,
        tempPrefix: "queue",
        cleanupTmpMaxAgeMs: 1,
      }),
    ).resolves.toEqual([{ ok: true }]);
    await expect(fs.access(tempPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects whitespace-padded queue ids", async () => {
    const queueDir = path.join(root, "queue");

    expect(() => resolveJsonDurableQueueEntryPaths(queueDir, "job ")).toThrow();
    expect(() => resolveJsonDurableQueueEntryPaths(queueDir, " job")).toThrow();
  });

  itPosix("skips hardlinked pending entries", async () => {
    const queueDir = path.join(root, "queue");
    const failedDir = path.join(root, "failed");
    await ensureJsonDurableQueueDirs({ queueDir, failedDir });
    const outside = path.join(root, "outside.json");
    await fs.writeFile(outside, JSON.stringify({ leaked: true }), "utf8");
    await fs.link(outside, path.join(queueDir, "leak.json"));

    await expect(
      loadPendingJsonDurableQueueEntries<{ leaked: boolean }>({ queueDir, tempPrefix: "queue" }),
    ).resolves.toEqual([]);
  });
});
