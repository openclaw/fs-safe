import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as directoryDurability from "../src/directory-durability.js";
import {
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  resolveJsonDurableQueueEntryPaths,
  type JsonDurableQueueReadResult,
} from "../src/json-durable-queue.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

type Entry = { version: number };
type Loader = "single" | "batch";
type Read = (entry: Entry) => Promise<JsonDurableQueueReadResult<Entry>>;

const { tempRoot } = useRealTempDirs();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
  configureFsSafeNative({ mode: "auto" });
});

async function fixture(loader: Loader, processing = true) {
  const queueDir = await tempRoot("fs-safe-queue-migration-retry-durability-");
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
  await fs.writeFile(processing ? paths.processingPath! : paths.jsonPath, '{"version":1}');
  const load = (read: Read) => loader === "single"
    ? loadJsonDurableQueueEntry<Entry>({ paths, tempPrefix: "queue", read })
    : loadPendingJsonDurableQueueEntries<Entry>({ queueDir, tempPrefix: "queue", read });
  return { queueDir, paths, load };
}

function observeDirectorySyncs(
  directoryPath: string,
  events: string[],
  beforeSync?: () => void,
  syncEvent = "queue-sync",
) {
  const syncDirectory = directoryDurability.syncDirectory;
  vi.spyOn(directoryDurability, "syncDirectory").mockImplementation(async (...args) => {
    const target = typeof args[0] === "string" ? args[0] : args[0].path;
    if (path.resolve(target) !== directoryPath) return await syncDirectory(...args);
    try {
      const outcome = await syncDirectory(...args);
      // The owner also accepts unsupported Windows directory synchronization.
      events.push(syncEvent);
      return outcome;
    } catch (error) {
      events.push(`${syncEvent}-failed`);
      throw error;
    }
  });
  if (!beforeSync) return;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (path.resolve(args[0].toString()) === directoryPath) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        beforeSync();
        await sync();
      });
    }
    return handle;
  });
}

describe.each(["single", "batch"] as const)("%s conditional queue migration durability", (loader) => {
  it("repairs failed publication sync without rewriting an already migrated entry", async () => {
    const { queueDir, paths, load } = await fixture(loader);
    const failure = Object.assign(new Error("migration directory sync failed"), { code: "EIO" });
    const events: string[] = [];
    let publications = 0;
    let failSync = true;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (destination === paths.processingPath) {
        publications++;
        events.push("migration-published");
      }
    });
    observeDirectorySyncs(queueDir, events, () => {
      if (publications > 0 && failSync) throw failure;
    });
    const read: Read = async (entry) => {
      events.push(`read:${entry.version}`);
      return entry.version === 1
        ? { entry: { version: 2 }, migrated: true }
        : { entry, migrated: false };
    };

    await expect(load(read)).rejects.toBe(failure);
    expect(publications).toBe(1);
    expect(events.slice(-3)).toEqual(["read:1", "migration-published", "queue-sync-failed"]);
    const publishedBytes = await fs.readFile(paths.processingPath!, "utf8");
    const publishedIdentity = await fs.lstat(paths.processingPath!, { bigint: true });
    expect(JSON.parse(publishedBytes)).toEqual({ version: 2 });

    events.length = 0;
    await expect(load(read)).rejects.toBe(failure);
    expect(events).toEqual(["queue-sync-failed"]);
    expect(publications).toBe(1);

    events.length = 0;
    failSync = false;
    await expect(load(read)).resolves.toEqual(loader === "single" ? { version: 2 } : [{ version: 2 }]);
    expect(events).toEqual(["queue-sync", "read:2"]);
    expect(publications).toBe(1);
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe(publishedBytes);
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({
      dev: publishedIdentity.dev, ino: publishedIdentity.ino, nlink: 1n,
    });
    await expect(fs.access(paths.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs an existing processing file discovered during exclusive claim", async () => {
    const { queueDir, paths, load } = await fixture(loader, false);
    const failure = Object.assign(new Error("raced claim sync failed"), { code: "EIO" });
    const link = fs.link.bind(fs);
    let raced = false;
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      if (!raced && target === paths.processingPath) {
        raced = true;
        await fs.writeFile(paths.processingPath!, '{"version":2}');
      }
      await link(source, target);
    });
    let failSync = true;
    const events: string[] = [];
    observeDirectorySyncs(queueDir, events, () => {
      if (failSync) throw failure;
    });
    const read = vi.fn(async (entry: Entry) => ({ entry, migrated: false }));

    await expect(load(read)).rejects.toBe(failure);
    expect(raced).toBe(true);
    expect(events).toEqual(["queue-sync-failed"]);
    expect(read).not.toHaveBeenCalled();
    const identity = await fs.lstat(paths.processingPath!, { bigint: true });
    failSync = false;
    events.length = 0;
    await expect(load(read)).resolves.toEqual(loader === "single" ? { version: 2 } : [{ version: 2 }]);
    expect(events).toEqual(["queue-sync"]);
    expect(read).toHaveBeenCalledOnce();
    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toBe('{"version":1}');
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({
      dev: identity.dev, ino: identity.ino, nlink: 1n,
    });
  });

  it.each(["existing-processing", "fresh-claim"] as const)("syncs %s before reading without redundant repair", async (state) => {
    const { queueDir, load } = await fixture(loader, state === "existing-processing");
    const events: string[] = [];
    observeDirectorySyncs(queueDir, events);

    await expect(load(async (entry) => {
      events.push("read");
      return { entry, migrated: false };
    })).resolves.toEqual(loader === "single" ? { version: 1 } : [{ version: 1 }]);

    // Fresh claims already sync the hardlink, retirement-root publication, and source retirement.
    const syncCount = state === "existing-processing" ? 1 : 3;
    expect(events).toEqual([...Array<string>(syncCount).fill("queue-sync"), "read"]);
  });
});

it.each(["same-parent", "separate-parent"] as const)("repairs a duplicate claim with a %s processing path", async (parent) => {
  const { queueDir, paths } = await fixture("single", false);
  const processingDir = parent === "same-parent" ? queueDir : path.join(queueDir, "claims");
  if (parent === "separate-parent") await fs.mkdir(processingDir, { mode: 0o700 });
  const processingPath = path.join(processingDir, "job.processing");
  await fs.link(paths.jsonPath, processingPath);
  const claimedIdentity = await fs.lstat(processingPath, { bigint: true });
  const events: string[] = [];
  observeDirectorySyncs(processingDir, events, undefined, "processing-parent-sync");

  await expect(loadJsonDurableQueueEntry<Entry>({
    paths: { ...paths, processingPath },
    tempPrefix: "queue",
    read: async (entry) => {
      events.push("read");
      return { entry, migrated: false };
    },
  })).resolves.toEqual({ version: 1 });

  const syncCount = parent === "same-parent" ? 2 : 1;
  expect(events).toEqual([...Array<string>(syncCount).fill("processing-parent-sync"), "read"]);
  await expect(fs.access(paths.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.lstat(processingPath, { bigint: true })).resolves.toMatchObject({
    dev: claimedIdentity.dev, ino: claimedIdentity.ino, nlink: 1n,
  });
});

describe("directory sync observation", () => {
  it.each(["EPERM", "EINVAL"])("records Windows %s as an accepted unsupported outcome", async (code) => {
    const directoryPath = await tempRoot("fs-safe-sync-observation-");
    const failure = Object.assign(new Error("directory sync unsupported"), { code });
    const events: string[] = [];
    Object.defineProperty(process, "platform", { value: "win32" });
    observeDirectorySyncs(directoryPath, events, () => { throw failure; });

    await expect(directoryDurability.syncDirectory(directoryPath))
      .resolves.toEqual({ status: "unsupported", code });
    expect(events).toEqual(["queue-sync"]);
  });

  it("preserves deliberate Windows EIO failures", async () => {
    const directoryPath = await tempRoot("fs-safe-sync-observation-");
    const failure = Object.assign(new Error("injected directory sync failure"), { code: "EIO" });
    const events: string[] = [];
    Object.defineProperty(process, "platform", { value: "win32" });
    observeDirectorySyncs(directoryPath, events, () => { throw failure; });

    await expect(directoryDurability.syncDirectory(directoryPath)).rejects.toBe(failure);
    expect(events).toEqual(["queue-sync-failed"]);
  });
});
