import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ackJsonDurableQueueEntry,
  ensureJsonDurableQueueDirs,
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  moveJsonDurableQueueEntryToFailed,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
} from "../src/json-durable-queue.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  configureFsSafeNative({ mode: "auto" });
  vi.restoreAllMocks();
});

async function queueFixture(id = "job") {
  const root = await tempRoot("fs-safe-queue-generation-");
  const queueDir = path.join(root, "queue");
  const failedDir = path.join(root, "failed");
  await ensureJsonDurableQueueDirs({ queueDir, failedDir });
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, id);
  return { queueDir, failedDir, paths };
}

async function writeGeneration(filePath: string, generation: number): Promise<void> {
  await writeJsonDurableQueueEntry({
    filePath,
    entry: { generation },
    tempPrefix: "queue",
  });
}

describe("durable queue generation ownership", () => {
  it("does not overwrite a concurrent processing claim", async () => {
    const { paths } = await queueFixture();
    await writeGeneration(paths.processingPath!, 1);
    await writeGeneration(paths.jsonPath, 2);

    await expect(loadJsonDurableQueueEntry({
      paths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 1 });

    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toContain('"generation": 2');
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toContain(
      '"generation": 1',
    );
  });

  it("claims entries addressed through relative queue paths", async () => {
    const { queueDir } = await queueFixture();
    const relativePaths = resolveJsonDurableQueueEntryPaths(
      path.relative(process.cwd(), queueDir),
      "relative-job",
    );
    await writeGeneration(relativePaths.jsonPath, 1);

    await expect(loadJsonDurableQueueEntry<{ generation: number }>({
      paths: relativePaths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 1 });
  });

  it("claims near-limit queue ids without expanding their path component", async () => {
    const { paths } = await queueFixture("x".repeat(240));
    await writeGeneration(paths.jsonPath, 1);

    await expect(loadJsonDurableQueueEntry<{ generation: number }>({
      paths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 1 });

    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toContain(
      '"generation": 1',
    );
  });

  it("atomically claims one generation while a producer replaces the source", async () => {
    const { queueDir, paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    const link = fs.link.bind(fs);
    const rename = fs.rename.bind(fs);
    let intercepted = false;
    vi.spyOn(fs, "link").mockImplementation(async (sourcePath, targetPath) => {
      if (!intercepted && sourcePath === paths.jsonPath && targetPath === paths.processingPath) {
        intercepted = true;
        const replacementPath = path.join(queueDir, ".replacement.tmp");
        await fs.writeFile(replacementPath, JSON.stringify({ generation: 2 }));
        await rename(replacementPath, paths.jsonPath);
        await link(paths.jsonPath, paths.processingPath!);
        const newerPath = path.join(queueDir, ".newer.tmp");
        await fs.writeFile(newerPath, JSON.stringify({ generation: 3 }));
        await rename(newerPath, paths.jsonPath);
        return;
      }
      return await link(sourcePath, targetPath);
    });

    await expect(loadJsonDurableQueueEntry<{ generation: number }>({
      paths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 2 });

    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toContain('"generation":3');
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toContain('"generation":2');
  });

  it("retires a duplicate source left after hardlink claim", async () => {
    const { paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    await fs.link(paths.jsonPath, paths.processingPath!);

    await expect(loadJsonDurableQueueEntry<{ generation: number }>({
      paths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 1 });
    await expect(fs.access(paths.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });

    await ackJsonDurableQueueEntry(paths);
    await expect(loadJsonDurableQueueEntry({
      paths,
      tempPrefix: "queue",
    })).resolves.toBeNull();
  });

  it("cleans an empty retirement record before claiming", async () => {
    const { queueDir, paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    const recordPath = path.join(queueDir, ".fs-safe-retirements", "job.json");
    await fs.mkdir(recordPath, { recursive: true, mode: 0o700 });

    await expect(loadJsonDurableQueueEntry<{ generation: number }>({
      paths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 1 });

    await expect(fs.access(recordPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a source retirement interrupted after claiming", async () => {
    const { queueDir, paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    await fs.link(paths.jsonPath, paths.processingPath!);
    const recordPath = path.join(queueDir, ".fs-safe-retirements", "job.json");
    const entryPath = path.join(recordPath, "entry");
    await fs.mkdir(recordPath, { recursive: true, mode: 0o700 });
    await fs.rename(paths.jsonPath, entryPath);

    await expect(loadJsonDurableQueueEntry<{ generation: number }>({
      paths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 1 });

    await expect(fs.access(entryPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({
      nlink: 1n,
    });
  });

  it("does not retire newer processing state for a stale delivered marker", async () => {
    const { queueDir, paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
    await fs.copyFile(paths.processingPath!, paths.deliveredPath);
    await fs.unlink(paths.processingPath!);
    await writeGeneration(paths.jsonPath, 2);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });

    await expect(loadPendingJsonDurableQueueEntries<{ generation: number }>({
      queueDir,
      tempPrefix: "queue",
    })).resolves.toEqual([{ generation: 2 }]);

    await expect(fs.access(paths.deliveredPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toContain(
      '"generation": 2',
    );
  });

  it("acknowledges current processing after cleaning a stale delivered marker", async () => {
    const { paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
    await fs.copyFile(paths.processingPath!, paths.deliveredPath);
    await fs.unlink(paths.processingPath!);
    await writeGeneration(paths.jsonPath, 2);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });

    await ackJsonDurableQueueEntry(paths);

    await expect(fs.access(paths.deliveredPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(paths.processingPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(paths.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("completes an interrupted delivered marker before batch loading", async () => {
    const { queueDir, paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
    await fs.rename(paths.processingPath!, paths.deliveredPath);
    await writeGeneration(paths.jsonPath, 2);

    await expect(loadPendingJsonDurableQueueEntries<{ generation: number }>({
      queueDir,
      tempPrefix: "queue",
    })).resolves.toEqual([{ generation: 2 }]);

    await expect(fs.access(paths.deliveredPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toContain(
      '"generation": 2',
    );
  });

  it("acknowledges only the generation claimed by load", async () => {
    const { paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    await expect(loadJsonDurableQueueEntry<{ generation: number }>({
      paths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 1 });
    await writeGeneration(paths.jsonPath, 2);

    await ackJsonDurableQueueEntry(paths);

    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toContain('"generation": 2');
    await expect(fs.access(paths.processingPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(paths.deliveredPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(loadJsonDurableQueueEntry<{ generation: number }>({
      paths,
      tempPrefix: "queue",
    })).resolves.toEqual({ generation: 2 });
  });

  it("quarantines the claimed generation without moving its replacement", async () => {
    const { queueDir, failedDir, paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
    await writeGeneration(paths.jsonPath, 2);

    await moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "job" });

    await expect(fs.readFile(path.join(failedDir, "job.json"), "utf8")).resolves.toContain(
      '"generation": 1',
    );
    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toContain('"generation": 2');
  });

  it("completes an interrupted hardlink quarantine", async () => {
    const { queueDir, failedDir, paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
    const failedPath = path.join(failedDir, "job.json");
    await fs.link(paths.processingPath!, failedPath);

    await expect(
      moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "job" }),
    ).resolves.toBeUndefined();

    await expect(fs.access(paths.processingPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(failedPath, "utf8")).resolves.toContain('"generation": 1');
    await expect(fs.lstat(failedPath, { bigint: true })).resolves.toMatchObject({ nlink: 1n });
  });

  it("preserves prior quarantine evidence on a destination collision", async () => {
    const { queueDir, failedDir, paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
    const failedPath = path.join(failedDir, "job.json");
    await fs.writeFile(failedPath, JSON.stringify({ generation: "older-failure" }));

    await expect(
      moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "job" }),
    ).rejects.toBeDefined();
    await expect(fs.readFile(failedPath, "utf8")).resolves.toContain("older-failure");
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toContain(
      '"generation": 1',
    );
  });

  it("does not treat identical failed content as generation ownership", async () => {
    const { queueDir, failedDir, paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
    const failedPath = path.join(failedDir, "job.json");
    await fs.copyFile(paths.processingPath!, failedPath);

    await expect(
      moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "job" }),
    ).rejects.toBeDefined();

    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toContain(
      '"generation": 1',
    );
    const processing = await fs.lstat(paths.processingPath!, { bigint: true });
    const failed = await fs.lstat(failedPath, { bigint: true });
    expect({ dev: processing.dev, ino: processing.ino }).not.toEqual({
      dev: failed.dev,
      ino: failed.ino,
    });
  });

  it("resumes a claimed generation before a queued replacement", async () => {
    const { queueDir, paths } = await queueFixture();
    await writeGeneration(paths.jsonPath, 1);
    const seenPaths: string[] = [];
    await loadJsonDurableQueueEntry({
      paths,
      tempPrefix: "queue",
      read: async (entry, filePath) => {
        seenPaths.push(filePath);
        return { entry };
      },
    });
    await writeGeneration(paths.jsonPath, 2);

    await expect(loadPendingJsonDurableQueueEntries<{ generation: number }>({
      queueDir,
      tempPrefix: "queue",
    })).resolves.toEqual([{ generation: 1 }]);
    expect(seenPaths).toEqual([paths.jsonPath]);

    await ackJsonDurableQueueEntry(paths);
    await expect(loadPendingJsonDurableQueueEntries<{ generation: number }>({
      queueDir,
      tempPrefix: "queue",
    })).resolves.toEqual([{ generation: 2 }]);
  });
});
