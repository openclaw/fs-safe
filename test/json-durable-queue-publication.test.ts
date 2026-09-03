import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
import {
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
} from "../src/json-durable-queue.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

describe("durable queue post-sync publication identity", () => {
  for (const operation of ["enqueue", "single-migration", "batch-migration"] as const) {
    itPosix.each([false, true])(`${operation} rejects a swap during directory sync (same bytes=%s)`, async (sameBytes) => {
      const root = await tempRoot("fs-safe-queue-post-sync-");
      const queueDir = path.join(root, "queue");
      await fs.mkdir(queueDir, { mode: 0o700 });
      const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
      const target = operation === "enqueue" ? paths.jsonPath : paths.processingPath!;
      if (operation !== "enqueue") await fs.writeFile(target, '{"generation":1}');
      const published = JSON.stringify({ generation: 2 }, null, 2);
      const replacement = sameBytes ? published : '{"generation":"foreign"}';
      const foreign = path.join(root, "foreign");
      const saved = path.join(root, "saved");
      await fs.writeFile(foreign, replacement);
      const foreignIdentity = await fs.lstat(foreign, { bigint: true });
      const realOpen = fs.open.bind(fs);
      const realRename = fs.rename.bind(fs);
      let didPublish = false;
      let didSwap = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await realRename(source, destination);
        if (destination === target) didPublish = true;
      });
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (args[0].toString() === queueDir) {
          const realSync = handle.sync.bind(handle);
          vi.spyOn(handle, "sync").mockImplementation(async () => {
            await realSync();
            if (didPublish && !didSwap) {
              didSwap = true;
              await realRename(target, saved);
              await realRename(foreign, target);
            }
          });
        }
        return handle;
      });
      const read = async () => ({ entry: { generation: 2 }, migrated: true });
      const write = operation === "enqueue"
        ? () => writeJsonDurableQueueEntry({ filePath: target, entry: { generation: 2 }, tempPrefix: "queue" })
        : operation === "single-migration"
          ? () => loadJsonDurableQueueEntry({ paths, tempPrefix: "queue", read })
          : () => loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "queue", read });

      await expect(write()).rejects.toMatchObject({ code: "path-mismatch" });

      expect(didSwap).toBe(true);
      await expect(fs.readFile(saved, "utf8")).resolves.toBe(published);
      await expect(fs.readFile(target, "utf8")).resolves.toBe(replacement);
      const current = await fs.lstat(target, { bigint: true });
      expect({ dev: current.dev, ino: current.ino }).toEqual({ dev: foreignIdentity.dev, ino: foreignIdentity.ino });
      expect((await fs.readdir(queueDir)).some((name) => name.endsWith(".tmp"))).toBe(false);
    });
  }
});
