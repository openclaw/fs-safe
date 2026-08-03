import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import { fileStore } from "../src/file-store.js";
import {
  ensureJsonDurableQueueDirs,
  readJsonDurableQueueEntry,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
} from "../src/json-durable-queue.js";
import { jsonStore } from "../src/json-store.js";

const { tempRoot } = useTempDirs();

function circularValue(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

describe("store stress matrix", () => {
  it.each([false, true])(
    "keeps targets intact across stream failures (private=%s)",
    async (privateMode) => {
      const root = await tempRoot("fs-safe-store-failures-");
      const asyncStore = fileStore({ rootDir: root, private: privateMode });
      await asyncStore.writeText("stream.txt", "complete");

      const brokenStream = Readable.from(
        (async function* () {
          yield "partial";
          throw new Error("stream failed");
        })(),
      );
      await expect(asyncStore.writeStream("stream.txt", brokenStream)).rejects.toThrow(
        "stream failed",
      );

      await expect(asyncStore.readText("stream.txt")).resolves.toBe("complete");
      expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

  it.each([false, true])(
    "publishes only complete JSON during overlapping reads and writes (private=%s)",
    async (privateMode) => {
      const root = await tempRoot("fs-safe-store-overlap-");
      const store = fileStore({ rootDir: root, private: privateMode });
      const payloadFor = (index: number) => `${index}:`.padEnd(4 * 1024, String(index % 10));
      await store.writeJson("state.json", { index: -1, payload: payloadFor(-1) });

      const writes = Array.from({ length: 16 }, async (_, index) => {
        await store.writeJson("state.json", { index, payload: payloadFor(index) });
      });
      const reads = Array.from({ length: 48 }, async () => {
        const value = await store.readJson<{ index: number; payload: string }>("state.json");
        expect(value.payload).toBe(payloadFor(value.index));
      });
      await Promise.all([...writes, ...reads]);

      const final = await store.readJson<{ index: number; payload: string }>("state.json");
      expect(final.payload).toBe(payloadFor(final.index));
    },
  );

  it("releases JSON-store serialization and sidecar locks after callback and serializer failures", async () => {
    const root = await tempRoot("fs-safe-json-store-recovery-");
    const filePath = path.join(root, "state.json");
    const primary = jsonStore<unknown>({ filePath, lock: true });
    await primary.write({ count: 0 });

    await expect(primary.update(() => circularValue())).rejects.toThrow(TypeError);
    await expect(primary.update(() => Promise.reject(new Error("callback failed")))).rejects.toThrow(
      "callback failed",
    );

    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const store = jsonStore<{ count: number }>({
          filePath,
          lock:
            index % 2 === 0
              ? true
              : { managerKey: `fs-safe-store-stress-${index}` },
        });
        await store.update((current) => ({ count: (current?.count ?? 0) + 1 }));
      }),
    );

    await expect(jsonStore<{ count: number }>({ filePath }).readRequired()).resolves.toEqual({
      count: 12,
    });
  }, 20_000);

  it("serializes queue writers and preserves the last complete entry on serializer failure", async () => {
    const root = await tempRoot("fs-safe-queue-writers-");
    const queueDir = path.join(root, "queue");
    const failedDir = path.join(root, "failed");
    await ensureJsonDurableQueueDirs({ queueDir, failedDir });
    const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
    await writeJsonDurableQueueEntry({
      filePath: paths.jsonPath,
      entry: { index: -1, payload: "initial" },
      tempPrefix: "queue",
    });

    await expect(
      writeJsonDurableQueueEntry({
        filePath: paths.jsonPath,
        entry: circularValue(),
        tempPrefix: "queue",
      }),
    ).rejects.toThrow(TypeError);
    await expect(readJsonDurableQueueEntry(paths.jsonPath)).resolves.toEqual({
      index: -1,
      payload: "initial",
    });

    await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        await writeJsonDurableQueueEntry({
          filePath: paths.jsonPath,
          entry: { index, payload: `${index}:`.padEnd(4096, "x") },
          tempPrefix: "queue",
        });
      }),
    );
    const final = await readJsonDurableQueueEntry<{ index: number; payload: string }>(
      paths.jsonPath,
    );
    expect(final.payload).toBe(`${final.index}:`.padEnd(4096, "x"));
    expect((await fs.readdir(queueDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("applies prune depth bounds without deleting fresh or deeper entries", async () => {
    const root = await tempRoot("fs-safe-store-prune-depth-");
    const store = fileStore({ rootDir: root });
    await store.writeText("old-root.txt", "old");
    await store.writeText("one/old-one.txt", "old");
    await store.writeText("one/two/old-two.txt", "old");
    await store.writeText("one/fresh.txt", "fresh");
    const old = new Date(Date.now() - 60_000);
    await Promise.all(
      ["old-root.txt", "one/old-one.txt", "one/two/old-two.txt"].map(async (key) => {
        await fs.utimes(store.path(key), old, old);
      }),
    );

    await store.pruneExpired({ ttlMs: 30_000, maxDepth: 1 });
    await expect(store.exists("old-root.txt")).resolves.toBe(false);
    await expect(store.exists("one/old-one.txt")).resolves.toBe(false);
    await expect(store.exists("one/two/old-two.txt")).resolves.toBe(true);
    await expect(store.readText("one/fresh.txt")).resolves.toBe("fresh");
  });

});
