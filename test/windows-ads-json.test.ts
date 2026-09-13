import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
  writeJsonDurableQueueEntry,
} from "../src/json-durable-queue.js";
import { moveDurableQueueEntryToFailed } from "../src/json-durable-queue-ownership.js";
import { jsonStore } from "../src/json-store.js";
import {
  readRootJsonObjectSync,
  writeJsonSync,
} from "../src/json.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

function expectInvalidPath(run: () => unknown): void {
  expect(run).toThrow(expect.objectContaining({
    code: "invalid-path",
    details: { reason: "windows-path-alias" },
  }));
}

async function expectInvalidPathAsync(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    code: "invalid-path",
    details: { reason: "windows-path-alias" },
  });
}

describe.runIf(process.platform === "win32")("Windows JSON namespace aliases", () => {
  it("rejects synchronous JSON stream writes before creating or replacing anything", async () => {
    const root = await tempRoot("fs-safe-json-ads-write-");
    const carrier = path.join(root, "state.json");
    const streamPath = `${carrier}:hidden`;
    await fs.writeFile(carrier, "unchanged");

    expectInvalidPath(() => writeJsonSync(streamPath, { changed: true }));

    await expect(fs.readFile(carrier, "utf8")).resolves.toBe("unchanged");
    await expect(fs.access(streamPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(root)).resolves.toEqual(["state.json"]);
  });

  it("rejects raw root-bounded JSON aliases through the existing open failure union", async () => {
    const root = await tempRoot("fs-safe-root-json-ads-");
    const configPath = path.join(root, "config.json");
    await fs.writeFile(configPath, "{}");
    await fs.writeFile(`${configPath}:hidden`, JSON.stringify({ secret: true }));

    const variants = [
      { rootDir: root, relativePath: "config.json:hidden" },
      { rootDir: `${root}:hidden`, relativePath: "config.json" },
      { rootDir: root, rootRealPath: `${root}:hidden`, relativePath: "config.json" },
    ];
    for (const variant of variants) {
      expect(readRootJsonObjectSync({
        ...variant,
        boundaryLabel: "test JSON root",
      })).toMatchObject({
        ok: false,
        reason: "open",
        failure: {
          ok: false,
          reason: "validation",
          error: {
            code: "invalid-path",
            details: { reason: "windows-path-alias" },
          },
        },
      });
    }
  });

  it("rejects jsonStore aliases before resolving or preparing their parent", async () => {
    const root = await tempRoot("fs-safe-json-store-ads-");
    const carrier = path.join(root, "state.json");

    expectInvalidPath(() => jsonStore({ filePath: `${carrier}:hidden` }));

    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("rejects direct durable-queue stream access without reading, writing, or unlinking it", async () => {
    const root = await tempRoot("fs-safe-json-queue-ads-direct-");
    const carrier = path.join(root, "entry.json");
    const streamPath = `${carrier}:hidden`;
    await fs.writeFile(carrier, "carrier");
    await fs.writeFile(streamPath, JSON.stringify({ secret: true }));

    await expectInvalidPathAsync(readJsonDurableQueueEntry(streamPath));
    await expectInvalidPathAsync(jsonDurableQueueEntryExists(streamPath));
    await expect(unlinkBestEffort(streamPath)).resolves.toBeUndefined();
    await expectInvalidPathAsync(writeJsonDurableQueueEntry({
      filePath: streamPath,
      entry: { changed: true },
      tempPrefix: "queue",
    }));

    await expect(fs.readFile(streamPath, "utf8")).resolves.toBe(JSON.stringify({ secret: true }));
    await expect(fs.readFile(carrier, "utf8")).resolves.toBe("carrier");
  });

  it("validates every independently supplied queue path before taking a transfer lock", async () => {
    const root = await tempRoot("fs-safe-json-queue-ads-paths-");
    const base = resolveJsonDurableQueueEntryPaths(root, "job");
    const variants = [
      { ...base, jsonPath: `${base.jsonPath}:hidden` },
      { ...base, deliveredPath: `${base.deliveredPath}:hidden` },
      { ...base, processingPath: `${base.processingPath}:hidden` },
    ];

    for (const paths of variants) {
      await expectInvalidPathAsync(loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" }));
      await expectInvalidPathAsync(ackJsonDurableQueueEntry(paths));
    }

    await expectInvalidPathAsync(moveDurableQueueEntryToFailed({
      paths: base,
      failedPath: `${path.join(root, "failed.json")}:hidden`,
    }));
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("rejects queue directory-index aliases before cleanup or failed-entry moves", async () => {
    const root = await tempRoot("fs-safe-json-queue-index-");
    const queueDir = path.join(root, "queue");
    const failedDir = path.join(root, "failed");
    await fs.mkdir(queueDir);
    await fs.mkdir(failedDir);
    await fs.writeFile(path.join(queueDir, "job.json"), "{}");
    const queueAlias = `${queueDir}::$INDEX_ALLOCATION`;
    const failedAlias = `${failedDir}::$INDEX_ALLOCATION`;

    expectInvalidPath(() => resolveJsonDurableQueueEntryPaths(queueAlias, "job"));
    await expectInvalidPathAsync(ensureJsonDurableQueueDirs({
      queueDir: queueAlias,
      failedDir,
    }));
    await expectInvalidPathAsync(loadPendingJsonDurableQueueEntries({
      queueDir: queueAlias,
      tempPrefix: "queue",
      cleanupTmpMaxAgeMs: 0,
    }));
    await expectInvalidPathAsync(moveJsonDurableQueueEntryToFailed({
      queueDir,
      failedDir: failedAlias,
      id: "job",
    }));

    await expect(fs.readFile(path.join(queueDir, "job.json"), "utf8")).resolves.toBe("{}");
    await expect(fs.readdir(failedDir)).resolves.toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("POSIX JSON colon paths", () => {
  it("keeps accepting colon-bearing standalone, root-bounded, store, and queue paths", async () => {
    const root = await tempRoot("fs-safe-json-colon-");
    const syncPath = path.join(root, "state:sync.json");
    writeJsonSync(syncPath, { kind: "sync" });
    expect(JSON.parse(fsSync.readFileSync(syncPath, "utf8"))).toEqual({ kind: "sync" });

    const rootPath = path.join(root, "config:profile.json");
    await fs.writeFile(rootPath, JSON.stringify({ profile: true }));
    expect(readRootJsonObjectSync({
      rootDir: root,
      relativePath: "config:profile.json",
      boundaryLabel: "POSIX JSON root",
    })).toMatchObject({ ok: true, value: { profile: true } });

    const store = jsonStore<{ count: number }>({
      filePath: path.join(root, "store:state.json"),
    });
    await store.write({ count: 1 });
    await expect(store.readRequired()).resolves.toEqual({ count: 1 });

    const queueDir = path.join(root, "queue:pending");
    const failedDir = path.join(root, "queue:failed");
    await ensureJsonDurableQueueDirs({ queueDir, failedDir });
    const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
    await writeJsonDurableQueueEntry({
      filePath: paths.jsonPath,
      entry: { queued: true },
      tempPrefix: "queue",
    });
    await expect(loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" })).resolves.toEqual({
      queued: true,
    });
    await ackJsonDurableQueueEntry(paths);
  });
});
