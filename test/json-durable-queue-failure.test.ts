import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itPosix, useTempDirs } from "./helpers/vitest.js";
import {
  ackJsonDurableQueueEntry,
  ensureJsonDurableQueueDirs,
  jsonDurableQueueEntryExists,
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  moveJsonDurableQueueEntryToFailed,
  readJsonDurableQueueEntry,
  resolveJsonDurableQueueEntryPaths,
  unlinkBestEffort,
} from "../src/json-durable-queue.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("durable JSON queue failure recovery", () => {
  it("resumes valid entries while discarding crash markers and refusing corrupt state", async () => {
    const root = await tempRoot("fs-safe-queue-resume-");
    const queueDir = path.join(root, "queue");
    const failedDir = path.join(root, "failed");
    await ensureJsonDurableQueueDirs({ queueDir, failedDir });

    await fs.writeFile(path.join(queueDir, "ready.json"), JSON.stringify({ version: 1 }));
    await fs.writeFile(path.join(queueDir, "truncated.json"), "{\"version\":");
    await fs.mkdir(path.join(queueDir, "directory.json"));
    await fs.writeFile(path.join(queueDir, "already.delivered"), "stale");
    const freshTmp = path.join(queueDir, "fresh.tmp");
    await fs.writeFile(freshTmp, "incomplete");

    await expect(
      loadPendingJsonDurableQueueEntries<{ version: number }>({
        queueDir,
        tempPrefix: "queue",
        cleanupTmpMaxAgeMs: 60_000,
        read: async (entry) => ({ entry: { version: entry.version + 1 }, migrated: true }),
      }),
    ).resolves.toEqual([{ version: 2 }]);
    await expect(fs.readFile(path.join(queueDir, "ready.json"), "utf8")).resolves.toContain(
      "\"version\": 2",
    );
    await expect(fs.access(path.join(queueDir, "already.delivered"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(freshTmp, "utf8")).resolves.toBe("incomplete");
    await expect(fs.readFile(path.join(queueDir, "truncated.json"), "utf8")).resolves.toBe(
      "{\"version\":",
    );
  });

  it("treats missing queue and ack state as an idempotent crash-resume boundary", async () => {
    const root = await tempRoot("fs-safe-queue-missing-");
    const queueDir = path.join(root, "missing");
    const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");

    await expect(
      loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "queue" }),
    ).resolves.toEqual([]);
    await expect(
      loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" }),
    ).resolves.toBeNull();
    await fs.mkdir(queueDir);
    await fs.writeFile(paths.deliveredPath, "crash residue");
    await ackJsonDurableQueueEntry(paths);
    await expect(fs.access(paths.deliveredPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(jsonDurableQueueEntryExists(paths.jsonPath)).resolves.toBe(false);
  });

  it("propagates inspection failures instead of treating them as missing", async () => {
    const root = await tempRoot("fs-safe-queue-inspect-");
    const queueDir = path.join(root, "queue");
    await fs.mkdir(queueDir);
    const filePath = path.join(queueDir, "job.json");
    await fs.writeFile(filePath, "{}");
    const denied = Object.assign(new Error("inspection denied"), { code: "EACCES" });
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(denied);
    await expect(jsonDurableQueueEntryExists(filePath)).rejects.toBe(denied);

    const readdirDenied = Object.assign(new Error("listing denied"), { code: "EACCES" });
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(readdirDenied);
    await expect(
      loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "queue" }),
    ).rejects.toBe(readdirDenied);
  });

  it("rejects non-files, oversized state, and growth after the initial size check", async () => {
    const root = await tempRoot("fs-safe-queue-bounded-");
    const directoryPath = path.join(root, "entry.json");
    const oversizedPath = path.join(root, "oversized.json");
    const growingPath = path.join(root, "growing.json");
    await fs.mkdir(directoryPath);
    await fs.writeFile(oversizedPath, "1234");
    await fs.writeFile(growingPath, "{}");

    await expect(readJsonDurableQueueEntry(directoryPath)).rejects.toThrow(
      "queue entry is not a regular file",
    );
    await expect(readJsonDurableQueueEntry(oversizedPath, { maxBytes: 3 })).rejects.toThrow(
      "queue entry exceeds 3 bytes",
    );

    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      await fs.appendFile(growingPath, "1234");
      return handle;
    });
    await expect(readJsonDurableQueueEntry(growingPath, { maxBytes: 3 })).rejects.toThrow(
      "queue entry exceeds 3 bytes",
    );
  });

  itPosix("rejects symlink and hardlink queue entries without reading their contents", async () => {
    const root = await tempRoot("fs-safe-queue-links-");
    const target = path.join(root, "target.json");
    const symlink = path.join(root, "symlink.json");
    const hardlink = path.join(root, "hardlink.json");
    await fs.writeFile(target, JSON.stringify({ secret: true }));
    await fs.symlink(target, symlink);
    await fs.link(target, hardlink);

    await expect(readJsonDurableQueueEntry(symlink)).rejects.toThrow(
      "queue entry is not a regular file",
    );
    await expect(readJsonDurableQueueEntry(hardlink)).rejects.toThrow(
      "queue entry hardlinks are not allowed",
    );
  });

  itPosix("refuses queue directories and failed destinations reached through symlinks", async () => {
    const root = await tempRoot("fs-safe-queue-dir-links-");
    const realQueue = path.join(root, "real-queue");
    const queueDir = path.join(root, "queue");
    const failedDir = path.join(root, "failed");
    await fs.mkdir(realQueue);
    await fs.symlink(realQueue, queueDir);

    await expect(ensureJsonDurableQueueDirs({ queueDir, failedDir })).rejects.toThrow(
      "durable queue path is not a directory",
    );
    await fs.unlink(queueDir);
    await fs.mkdir(queueDir);
    await fs.writeFile(path.join(queueDir, "job.json"), "{}");
    await fs.symlink(realQueue, failedDir);
    await expect(
      moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "job" }),
    ).rejects.toThrow("durable queue path is not a directory");
  });

  it("returns null for a non-file direct entry but propagates corrupt JSON", async () => {
    const root = await tempRoot("fs-safe-queue-direct-");
    const queueDir = path.join(root, "queue");
    await fs.mkdir(queueDir);
    const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
    await fs.mkdir(paths.jsonPath);
    await expect(loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" })).resolves.toBeNull();
    await fs.rm(paths.jsonPath, { recursive: true });
    await fs.writeFile(paths.jsonPath, "{");
    await expect(loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" })).rejects.toThrow(
      SyntaxError,
    );
  });

  it("does not mask a non-ENOENT ack failure", async () => {
    const root = await tempRoot("fs-safe-queue-ack-error-");
    const paths = resolveJsonDurableQueueEntryPaths(root, "job");
    await fs.writeFile(paths.jsonPath, "{}");
    const denied = Object.assign(new Error("rename denied"), { code: "EACCES" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(denied);
    await expect(ackJsonDurableQueueEntry(paths)).rejects.toBe(denied);
    expect(fsSync.existsSync(paths.jsonPath)).toBe(true);
  });

  it("ignores missing best-effort cleanup but propagates stale-temp inspection failures", async () => {
    const root = await tempRoot("fs-safe-queue-cleanup-failure-");
    const queueDir = path.join(root, "queue");
    await fs.mkdir(queueDir);
    const missing = path.join(queueDir, "missing.delivered");
    await expect(unlinkBestEffort(missing)).resolves.toBeUndefined();
    const tempPath = path.join(queueDir, "orphan.tmp");
    await fs.writeFile(tempPath, "tmp");
    const denied = Object.assign(new Error("temp inspection denied"), { code: "EACCES" });
    vi.spyOn(fs, "stat").mockRejectedValueOnce(denied);
    await expect(loadPendingJsonDurableQueueEntries({
      queueDir,
      tempPrefix: "queue",
      cleanupTmpMaxAgeMs: 0,
    })).rejects.toBe(denied);
  });

  it("detects a queue entry swapped after its descriptor is opened", async () => {
    const root = await tempRoot("fs-safe-queue-read-swap-");
    const filePath = path.join(root, "entry.json");
    const oldPath = path.join(root, "old.json");
    await fs.writeFile(filePath, "{}");
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      await fs.rename(filePath, oldPath);
      await fs.writeFile(filePath, "{}");
      return handle;
    });
    await expect(readJsonDurableQueueEntry(filePath)).rejects.toThrow(
      "queue entry changed during read",
    );
  });
});
