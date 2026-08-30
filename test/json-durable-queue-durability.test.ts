import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ackJsonDurableQueueEntry,
  ensureJsonDurableQueueDirs,
  loadJsonDurableQueueEntry,
  moveJsonDurableQueueEntryToFailed,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
} from "../src/json-durable-queue.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await tempRoot("fs-safe-queue-durability-");
  const queueDir = path.join(root, "queue");
  const failedDir = path.join(root, "failed");
  await ensureJsonDurableQueueDirs({ queueDir, failedDir });
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
  return { root, queueDir, failedDir, paths };
}

async function writeGeneration(filePath: string, generation: number): Promise<void> {
  await writeJsonDurableQueueEntry({
    filePath,
    entry: { generation },
    tempPrefix: "queue",
  });
}

function observeDirectorySyncs(events: string[]): void {
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const openedPath = path.resolve(args[0].toString());
    const realSync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      events.push(`sync:${openedPath}`);
      await realSync();
    });
    return handle;
  });
}

function failDirectorySyncOnce(
  directoryPath: string,
  failure: Error,
  occurrence = 1,
): void {
  const target = path.resolve(directoryPath);
  const realOpen = fs.open.bind(fs);
  let syncCalls = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (path.resolve(args[0].toString()) !== target) return handle;
    const realSync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      syncCalls += 1;
      if (syncCalls === occurrence) throw failure;
      await realSync();
    });
    return handle;
  });
}

describe("durable JSON queue transition durability", () => {
  it("syncs claim and acknowledgement directory transitions in order", async () => {
    const { queueDir, paths } = await fixture();
    await writeGeneration(paths.jsonPath, 1);
    const events: string[] = [];
    const realLink = fs.link.bind(fs);
    const realRename = fs.rename.bind(fs);
    const realUnlink = fs.unlink.bind(fs);
    observeDirectorySyncs(events);
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      if (target === paths.processingPath) events.push("claim-link");
      await realLink(source, target);
    });
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (target === paths.deliveredPath) events.push("ack-rename");
      if (path.basename(target.toString()) === "entry") events.push("retire-rename");
      await realRename(source, target);
    });
    vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (target === paths.deliveredPath) events.push("ack-unlink");
      await realUnlink(target);
    });

    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
    const queueSync = `sync:${path.resolve(queueDir)}`;
    const retirementSync = `sync:${path.join(
      path.resolve(queueDir),
      ".fs-safe-retirements",
      "job.json",
    )}`;
    const retireIndex = events.indexOf("retire-rename");
    const retirementEvents = events.slice(retireIndex + 1);
    expect(retireIndex).toBeGreaterThan(-1);
    expect(retirementEvents.indexOf(retirementSync)).toBeLessThan(
      retirementEvents.indexOf(queueSync),
    );

    await ackJsonDurableQueueEntry(paths);

    expect(events.indexOf("claim-link")).toBeLessThan(events.indexOf(queueSync));
    const renameIndex = events.indexOf("ack-rename");
    const unlinkIndex = events.indexOf("ack-unlink");
    expect(renameIndex).toBeGreaterThan(-1);
    expect(unlinkIndex).toBeGreaterThan(renameIndex);
    expect(events.slice(renameIndex + 1, unlinkIndex)).toContain(queueSync);
    expect(events.slice(unlinkIndex + 1)).toContain(queueSync);
  });

  it("propagates claim directory-sync failure and recovers the hardlink", async () => {
    const { queueDir, paths } = await fixture();
    await writeGeneration(paths.jsonPath, 1);
    failDirectorySyncOnce(
      queueDir,
      Object.assign(new Error("claim directory sync failed"), { code: "EIO" }),
    );

    await expect(loadJsonDurableQueueEntry({
      paths,
      tempPrefix: "queue",
    })).rejects.toThrow("claim directory sync failed");
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({
      nlink: 2n,
    });

    vi.restoreAllMocks();
    await expect(loadJsonDurableQueueEntry<{ generation: number }>({
      paths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 1 });
    await expect(fs.access(paths.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries retirement-root sync failure before source retirement", async () => {
    const { queueDir, paths } = await fixture();
    await writeGeneration(paths.jsonPath, 1);
    failDirectorySyncOnce(
      queueDir,
      Object.assign(new Error("retirement root sync failed"), { code: "EIO" }),
      2,
    );

    await expect(loadJsonDurableQueueEntry({
      paths,
      tempPrefix: "queue",
    })).rejects.toThrow("retirement root sync failed");
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({
      nlink: 2n,
    });
    await expect(fs.stat(path.join(queueDir, ".fs-safe-retirements"))).resolves.toMatchObject({});

    vi.restoreAllMocks();
    await expect(loadJsonDurableQueueEntry<{ generation: number }>({
      paths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 1 });
    await expect(fs.access(paths.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resyncs a restored replacement before deleting retirement evidence", async () => {
    const { queueDir, paths } = await fixture();
    await writeGeneration(paths.jsonPath, 1);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
    const recordPath = path.join(queueDir, ".fs-safe-retirements", "job.json");
    const entryPath = path.join(recordPath, "entry");
    await fs.mkdir(recordPath, { recursive: true, mode: 0o700 });
    await fs.writeFile(entryPath, JSON.stringify({ generation: 2 }));
    failDirectorySyncOnce(
      queueDir,
      Object.assign(new Error("restore directory sync failed"), { code: "EIO" }),
    );

    await expect(loadJsonDurableQueueEntry({
      paths,
      tempPrefix: "queue",
    })).rejects.toThrow("restore directory sync failed");
    await expect(fs.lstat(entryPath, { bigint: true })).resolves.toMatchObject({ nlink: 2n });
    await expect(fs.lstat(paths.jsonPath, { bigint: true })).resolves.toMatchObject({ nlink: 2n });

    vi.restoreAllMocks();
    failDirectorySyncOnce(
      queueDir,
      Object.assign(new Error("restore retry sync failed"), { code: "EIO" }),
    );
    await expect(loadJsonDurableQueueEntry({
      paths,
      tempPrefix: "queue",
    })).rejects.toThrow("restore retry sync failed");
    await expect(fs.access(entryPath)).resolves.toBeUndefined();

    vi.restoreAllMocks();
    await expect(loadJsonDurableQueueEntry<{ generation: number }>({
      paths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 1 });
    await expect(fs.access(entryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toContain('"generation":2');
  });

  it("propagates acknowledgement sync failure and resumes its delivered marker", async () => {
    const { queueDir, paths } = await fixture();
    await writeGeneration(paths.jsonPath, 1);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
    failDirectorySyncOnce(
      queueDir,
      Object.assign(new Error("ack directory sync failed"), { code: "EIO" }),
    );

    await expect(ackJsonDurableQueueEntry(paths)).rejects.toThrow(
      "ack directory sync failed",
    );
    await expect(fs.access(paths.processingPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(paths.deliveredPath, "utf8")).resolves.toContain('"generation": 1');

    vi.restoreAllMocks();
    await expect(ackJsonDurableQueueEntry(paths)).resolves.toBeUndefined();
    await expect(fs.access(paths.deliveredPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("propagates quarantine sync failure and completes the retained hardlink", async () => {
    const { queueDir, failedDir, paths } = await fixture();
    await writeGeneration(paths.jsonPath, 1);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
    failDirectorySyncOnce(
      failedDir,
      Object.assign(new Error("failed directory sync failed"), { code: "EIO" }),
    );

    await expect(
      moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "job" }),
    ).rejects.toThrow("failed directory sync failed");
    const failedPath = path.join(failedDir, "job.json");
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({
      nlink: 2n,
    });
    await expect(fs.lstat(failedPath, { bigint: true })).resolves.toMatchObject({ nlink: 2n });

    vi.restoreAllMocks();
    failDirectorySyncOnce(
      failedDir,
      Object.assign(new Error("failed retry sync failed"), { code: "EIO" }),
    );
    await expect(
      moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "job" }),
    ).rejects.toThrow("failed retry sync failed");
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({
      nlink: 2n,
    });

    vi.restoreAllMocks();
    await expect(
      moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "job" }),
    ).resolves.toBeUndefined();
    await expect(fs.access(paths.processingPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(failedPath, { bigint: true })).resolves.toMatchObject({ nlink: 1n });
  });

  it("resyncs every nested ancestor edge after creation failure", async () => {
    const root = await tempRoot("fs-safe-queue-nested-directory-sync-");
    const queueDir = path.join(root, "a", "b", "queue");
    const failedDir = path.join(root, "c", "failed");
    const nestedParent = path.join(await fs.realpath(root), "a");
    failDirectorySyncOnce(
      nestedParent,
      Object.assign(new Error("nested parent sync failed"), { code: "EIO" }),
    );

    await expect(ensureJsonDurableQueueDirs({ queueDir, failedDir })).rejects.toThrow(
      "nested parent sync failed",
    );
    await expect(fs.stat(queueDir)).resolves.toMatchObject({});

    vi.restoreAllMocks();
    failDirectorySyncOnce(
      nestedParent,
      Object.assign(new Error("nested parent retry sync failed"), { code: "EIO" }),
    );
    await expect(ensureJsonDurableQueueDirs({ queueDir, failedDir })).rejects.toThrow(
      "nested parent retry sync failed",
    );

    vi.restoreAllMocks();
    await expect(ensureJsonDurableQueueDirs({ queueDir, failedDir })).resolves.toBeUndefined();
    await expect(fs.stat(failedDir)).resolves.toMatchObject({});
  });

  it("reports directory creation sync failure after creating the directory", async () => {
    const root = await tempRoot("fs-safe-queue-directory-sync-");
    const queueDir = path.join(root, "queue");
    const failedDir = path.join(root, "failed");
    failDirectorySyncOnce(
      await fs.realpath(root),
      Object.assign(new Error("queue parent sync failed"), { code: "EIO" }),
    );

    await expect(ensureJsonDurableQueueDirs({ queueDir, failedDir })).rejects.toThrow(
      "queue parent sync failed",
    );
    await expect(fs.stat(queueDir)).resolves.toMatchObject({});
    await expect(fs.access(failedDir)).rejects.toMatchObject({ code: "ENOENT" });

    vi.restoreAllMocks();
    await expect(ensureJsonDurableQueueDirs({ queueDir, failedDir })).resolves.toBeUndefined();
    await expect(fs.stat(failedDir)).resolves.toMatchObject({});
  });
});
