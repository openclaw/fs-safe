import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import {
  ackJsonDurableQueueEntry,
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
  type JsonDurableQueueReadResult,
} from "../src/json-durable-queue.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

type Entry = { generation: number; migrated?: boolean };
type Loader = "single" | "batch";
type Read = (entry: Entry, filePath: string) => Promise<JsonDurableQueueReadResult<Entry>>;
type TrackedRead = { filePath: string; handle: FileHandle; closed: boolean; closeCalls: number };

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

async function fixture(loader: Loader) {
  const queueDir = await tempRoot("fs-safe-queue-migration-lifetime-");
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
  const write = async (generation: number) => await writeJsonDurableQueueEntry({
    filePath: paths.jsonPath, entry: { generation }, tempPrefix: "queue",
  });
  const load = (read?: Read) => loader === "single"
    ? loadJsonDurableQueueEntry<Entry>({ paths, tempPrefix: "queue", read })
    : loadPendingJsonDurableQueueEntries<Entry>({ queueDir, tempPrefix: "queue", read });
  await write(1);
  return { queueDir, paths, write, load };
}

function trackProcessingReads(
  processingPaths: string[],
  onOpen?: (record: TrackedRead) => Promise<void>,
) {
  const targets = new Set(processingPaths.map((filePath) => path.resolve(filePath)));
  const records: TrackedRead[] = [];
  let active = 0;
  let maxActive = 0;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const filePath = path.resolve(args[0].toString());
    const flags = args[1];
    const readOnly = flags === "r" || (typeof flags === "number" &&
      (flags & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === 0);
    if (targets.has(filePath) && readOnly) {
      const record: TrackedRead = { filePath, handle, closed: false, closeCalls: 0 };
      records.push(record);
      maxActive = Math.max(maxActive, ++active);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        record.closeCalls++;
        await close();
        if (!record.closed) {
          record.closed = true;
          active--;
        }
      });
      try {
        await onOpen?.(record);
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    return handle;
  });
  return { records, get active() { return active; }, get maxActive() { return maxActive; } };
}

function expectOpen(record: TrackedRead) {
  expect(record.closed).toBe(false);
  expect(record.closeCalls).toBe(0);
  expect(record.handle.fd).toBeGreaterThanOrEqual(0);
  expect(fsSync.fstatSync(record.handle.fd).isFile()).toBe(true);
}

function expectPublicationPin(record: TrackedRead) {
  if (process.platform !== "win32") {
    expectOpen(record);
    return;
  }
  expect(record.closed).toBe(true);
  expect(record.closeCalls).toBe(1);
  expect(record.handle.fd).toBe(-1);
}

function expectClosed(tracker: ReturnType<typeof trackProcessingReads>, count: number) {
  expect(tracker.records).toHaveLength(count);
  expect(tracker.active).toBe(0);
  for (const record of tracker.records) {
    expect(record.closed).toBe(true);
    expect(record.closeCalls).toBe(1);
    expect(record.handle.fd).toBe(-1);
  }
}

function pauseRead(load: (read: Read) => Promise<unknown>, read: Read) {
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const loading = load(async (entry, filePath) => {
    entered.resolve();
    await proceed.promise;
    return await read(entry, filePath);
  });
  const settled = loading.catch(() => undefined);
  const started = Promise.race([
    entered.promise,
    settled.then(() => { throw new Error("load completed before its read callback"); }),
  ]);
  return { loading, started, settled, resume: proceed.resolve };
}

async function advanceClaim(subject: Awaited<ReturnType<typeof fixture>>) {
  const { paths, write } = subject;
  await expect(loadJsonDurableQueueEntry<Entry>({ paths, tempPrefix: "queue" }))
    .resolves.toEqual({ generation: 1 });
  await write(2);
  await ackJsonDurableQueueEntry(paths);
  await expect(loadJsonDurableQueueEntry<Entry>({ paths, tempPrefix: "queue" }))
    .resolves.toEqual({ generation: 2 });
  return {
    bytes: await fs.readFile(paths.processingPath!, "utf8"),
    identity: await fs.lstat(paths.processingPath!, { bigint: true }),
  };
}

describe.each(["single", "batch"] as const)("%s queue migration descriptor lifetime", (loader) => {
  it("retains the read descriptor until its platform's publication boundary", async () => {
    const { paths, load } = await fixture(loader);
    const tracker = trackProcessingReads([paths.processingPath!]);
    const rename = fs.rename.bind(fs);
    let published = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === paths.processingPath) {
        expectPublicationPin(tracker.records[0]!);
        published = true;
      }
      await rename(source, destination);
    });
    const migrated = { generation: 1, migrated: true };
    await expect(load(async (entry) => {
      expect(tracker.records).toHaveLength(1);
      expectOpen(tracker.records[0]!);
      return { entry: { ...entry, migrated: true }, migrated: true };
    })).resolves.toEqual(loader === "single" ? migrated : [migrated]);

    expect(published).toBe(true);
    expectClosed(tracker, 1);
  });

  it.each(["callback", "stale-migration"] as const)("closes after %s rejection without changing a newer claim", async (rejection) => {
    const subject = await fixture(loader);
    const { paths, load } = subject;
    const tracker = trackProcessingReads([paths.processingPath!]);
    const failure = new Error("old generation callback failed");
    const paused = pauseRead(load, async (entry) => {
      expectOpen(tracker.records[0]!);
      if (rejection === "callback") throw failure;
      return { entry: { ...entry, migrated: true }, migrated: true };
    });
    const replacement = await (async () => {
      try {
        await paused.started;
        expectOpen(tracker.records[0]!);
        const next = await advanceClaim(subject);
        expectOpen(tracker.records[0]!);
        expect(tracker.active).toBe(1);
        return next;
      } finally {
        paused.resume();
        await paused.settled;
      }
    })();

    if (rejection === "stale-migration") {
      await expect(paused.loading).rejects.toBeInstanceOf(FsSafeError);
      await expect(paused.loading).rejects.toMatchObject({ code: "path-mismatch" });
    } else if (loader === "single") {
      await expect(paused.loading).rejects.toBe(failure);
    } else {
      await expect(paused.loading).resolves.toEqual([]);
    }
    expectClosed(tracker, 3);
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe(replacement.bytes);
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({
      dev: replacement.identity.dev, ino: replacement.identity.ino, nlink: 1n,
    });
  });

  it.each(["malformed-json", "post-open-hardlink"] as const)("closes after %s validation fails", async (invalid) => {
    const { queueDir, paths, load } = await fixture(loader);
    if (invalid === "malformed-json") await fs.writeFile(paths.jsonPath, "{");
    const tracker = trackProcessingReads([paths.processingPath!], async (record) => {
      if (invalid === "post-open-hardlink") {
        await fs.link(record.filePath, path.join(queueDir, "unexpected-link"));
      }
    });
    const read = vi.fn(async (entry: Entry) => ({ entry }));
    const loading = load(read);
    if (loader === "batch") {
      await expect(loading).resolves.toEqual([]);
    } else if (invalid === "malformed-json") {
      await expect(loading).rejects.toBeInstanceOf(SyntaxError);
    } else {
      await expect(loading).rejects.toThrow("queue entry hardlinks are not allowed");
    }

    expect(read).not.toHaveBeenCalled();
    expectClosed(tracker, 1);
  });

  it("closes after an injected migration publication failure", async () => {
    const { paths, load } = await fixture(loader);
    const tracker = trackProcessingReads([paths.processingPath!]);
    const failure = Object.assign(new Error("migration publication failed"), { code: "EIO" });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === paths.processingPath) {
        expectPublicationPin(tracker.records[0]!);
        throw failure;
      }
      await rename(source, destination);
    });

    await expect(load(async (entry) => {
      expectOpen(tracker.records[0]!);
      return { entry: { ...entry, migrated: true }, migrated: true };
    })).rejects.toBe(failure);

    expectClosed(tracker, 1);
    expect(JSON.parse(await fs.readFile(paths.processingPath!, "utf8"))).toEqual({ generation: 1 });
  });
});

it("holds at most one processing read descriptor during a batch", async () => {
  const { queueDir, paths, load } = await fixture("batch");
  const processingPaths = [paths.processingPath!];
  for (const generation of [2, 3]) {
    const next = resolveJsonDurableQueueEntryPaths(queueDir, `job-${generation}`);
    processingPaths.push(next.processingPath!);
    await writeJsonDurableQueueEntry({
      filePath: next.jsonPath, entry: { generation }, tempPrefix: "queue",
    });
  }
  const tracker = trackProcessingReads(processingPaths, async () => {
    expect(tracker.active).toBe(1);
    for (const previous of tracker.records.slice(0, -1)) {
      expect(previous.handle.fd).toBe(-1);
      expect(previous.closed).toBe(true);
    }
  });
  const entries = await load(async (entry) => {
    expect(tracker.active).toBe(1);
    expectOpen(tracker.records.at(-1)!);
    return { entry: { ...entry, migrated: true }, migrated: true };
  });

  expect(entries).toEqual(expect.arrayContaining([
    { generation: 1, migrated: true },
    { generation: 2, migrated: true },
    { generation: 3, migrated: true },
  ]));
  expect(entries).toHaveLength(3);
  expect(tracker.maxActive).toBe(1);
  expectClosed(tracker, 3);
});
