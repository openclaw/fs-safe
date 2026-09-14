import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  resolveJsonDurableQueueEntryPaths,
} from "../src/json-durable-queue.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

describe.each(["single", "batch"] as const)("%s migration publication receipt", (loader) => {
  it.each([false, true])("rejects a processing replacement during staging (same bytes=%s)", async (sameBytes) => {
    const directory = await tempRoot("fs-safe-queue-migration-staging-");
    const queueDir = path.join(directory, "queue");
    await fs.mkdir(queueDir, { mode: 0o700 });
    const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
    const oldBytes = '{"generation":1}';
    const replacementBytes = sameBytes ? oldBytes : '{"generation":2}';
    const replacement = path.join(directory, "replacement");
    const saved = path.join(directory, "saved");
    await fs.writeFile(paths.processingPath!, oldBytes);
    await fs.writeFile(replacement, replacementBytes);
    const identity = await fs.lstat(replacement, { bigint: true });
    const realOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const realSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          await realSync();
          if (!swapped) {
            swapped = true;
            await fs.rename(paths.processingPath!, saved);
            await fs.rename(replacement, paths.processingPath!);
          }
        });
      }
      return handle;
    });
    const read = async () => ({ entry: { generation: 1, migrated: true }, migrated: true });
    const loading = loader === "single"
      ? loadJsonDurableQueueEntry({ paths, tempPrefix: "queue", read })
      : loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "queue", read });

    await expect(loading).rejects.toMatchObject({ code: "path-mismatch" });
    expect(swapped).toBe(true);
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe(replacementBytes);
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({
      dev: identity.dev, ino: identity.ino, nlink: 1n,
    });
    await expect(fs.readFile(saved, "utf8")).resolves.toBe(oldBytes);
    expect(await fs.readdir(queueDir)).toEqual(["job.processing"]);
  });
});
