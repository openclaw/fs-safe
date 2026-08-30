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

async function queueFixture() {
  const root = await tempRoot("fs-safe-queue-generation-");
  const queueDir = path.join(root, "queue");
  const failedDir = path.join(root, "failed");
  await ensureJsonDurableQueueDirs({ queueDir, failedDir });
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
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
    await writeGeneration(paths.jsonPath, 2);
    configureFsSafeNative({ mode: "off" });
    const link = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementationOnce(async (sourcePath, targetPath) => {
      await writeGeneration(targetPath.toString(), 1);
      return await link(sourcePath, targetPath);
    });

    await expect(loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" })).resolves.toEqual({ generation: 1 });

    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toContain('"generation": 2');
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toContain('"generation": 1');
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
