import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsSafeError } from "../src/errors.js";
import {
  ackJsonDurableQueueEntry,
  ensureJsonDurableQueueDirs,
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  moveJsonDurableQueueEntryToFailed,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
  type JsonDurableQueueReadResult,
} from "../src/json-durable-queue.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

type Entry = { generation: number; migrated?: boolean };
type Loader = "single" | "batch";
type Read = (entry: Entry, filePath: string) => Promise<JsonDurableQueueReadResult<Entry>>;

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => configureFsSafeNative({ mode: "auto" }));

async function fixture(loader: Loader) {
  const root = await tempRoot("fs-safe-queue-migration-generation-");
  const queueDir = path.join(root, "queue");
  const failedDir = path.join(root, "failed");
  await ensureJsonDurableQueueDirs({ queueDir, failedDir });
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
  const write = async (generation: number) => await writeJsonDurableQueueEntry({
    filePath: paths.jsonPath,
    entry: { generation },
    tempPrefix: "queue",
  });
  const load = (read?: Read) => loader === "single"
    ? loadJsonDurableQueueEntry<Entry>({ paths, tempPrefix: "queue", read })
    : loadPendingJsonDurableQueueEntries<Entry>({ queueDir, tempPrefix: "queue", read });
  await write(1);
  return { queueDir, failedDir, paths, write, load };
}

function pauseMigration(load: (read: Read) => Promise<unknown>) {
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const loading = load(async (entry) => {
    entered.resolve();
    await proceed.promise;
    return { entry: { ...entry, migrated: true }, migrated: true };
  });
  const settled = loading.catch(() => undefined);
  const started = Promise.race([
    entered.promise,
    settled.then(() => { throw new Error("load completed before its migration callback"); }),
  ]);
  return { loading, started, settled, resume: proceed.resolve };
}

describe.each(["single", "batch"] as const)("%s queue migration generation ownership", (loader) => {
  it("rejects an old migration after another consumer claims the replacement", async () => {
    const { paths, write, load } = await fixture(loader);
    const paused = pauseMigration(load);
    let replacementBytes: string;
    let replacementIdentity: BigIntStats;
    try {
      await paused.started;
      await expect(loadJsonDurableQueueEntry<Entry>({ paths, tempPrefix: "queue" }))
        .resolves.toEqual({ generation: 1 });
      await write(2);
      await ackJsonDurableQueueEntry(paths);
      await expect(loadJsonDurableQueueEntry<Entry>({ paths, tempPrefix: "queue" }))
        .resolves.toEqual({ generation: 2 });
      replacementBytes = await fs.readFile(paths.processingPath!, "utf8");
      replacementIdentity = await fs.lstat(paths.processingPath!, { bigint: true });
    } finally {
      paused.resume();
      await paused.settled;
    }

    await expect(paused.loading).rejects.toBeInstanceOf(FsSafeError);
    await expect(paused.loading).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe(replacementBytes);
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({
      dev: replacementIdentity.dev, ino: replacementIdentity.ino, nlink: 1n,
    });
    await expect(fs.access(paths.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not resurrect processing after a concurrent quarantine", async () => {
    const { queueDir, failedDir, paths, write, load } = await fixture(loader);
    const failedPath = path.join(failedDir, "job.json");
    const paused = pauseMigration(load);
    let failedBytes: string;
    let failedIdentity: BigIntStats;
    try {
      await paused.started;
      await write(2);
      await moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "job" });
      failedBytes = await fs.readFile(failedPath, "utf8");
      failedIdentity = await fs.lstat(failedPath, { bigint: true });
    } finally {
      paused.resume();
      await paused.settled;
    }

    await expect(paused.loading).rejects.toBeInstanceOf(FsSafeError);
    await expect(paused.loading).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(fs.access(paths.processingPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(failedPath, "utf8")).resolves.toBe(failedBytes);
    await expect(fs.lstat(failedPath, { bigint: true })).resolves.toMatchObject({
      dev: failedIdentity.dev, ino: failedIdentity.ino, nlink: 1n,
    });
    expect(JSON.parse(failedBytes)).toEqual({ generation: 1 });
    expect(JSON.parse(await fs.readFile(paths.jsonPath, "utf8"))).toEqual({ generation: 2 });
  });

  it("allows the migration callback to enqueue the next generation", async () => {
    const { paths, write, load } = await fixture(loader);
    const migrated = { generation: 1, migrated: true };
    await expect(load(async (entry, filePath) => {
      expect(filePath).toBe(paths.jsonPath);
      await write(2);
      return { entry: { ...entry, migrated: true }, migrated: true };
    })).resolves.toEqual(loader === "single" ? migrated : [migrated]);

    expect(JSON.parse(await fs.readFile(paths.processingPath!, "utf8"))).toEqual(migrated);
    expect(JSON.parse(await fs.readFile(paths.jsonPath, "utf8"))).toEqual({ generation: 2 });
    await ackJsonDurableQueueEntry(paths);
    await expect(loadJsonDurableQueueEntry<Entry>({ paths, tempPrefix: "queue" }))
      .resolves.toEqual({ generation: 2 });
  });
});
