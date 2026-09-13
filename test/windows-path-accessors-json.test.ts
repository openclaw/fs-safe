import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fileStore, fileStoreSync, type FileStoreOptions } from "../src/file-store.js";
import {
  ensureJsonDurableQueueDirs,
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  moveJsonDurableQueueEntryToFailed,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
} from "../src/json-durable-queue.js";
import {
  moveDurableQueueEntryToFailed,
  validateDurableQueueEntryPaths,
  type DurableQueueEntryPathsLike,
} from "../src/json-durable-queue-ownership.js";
import { jsonStore, type JsonStoreOptions } from "../src/json-store.js";
import {
  readRootJsonObjectSync,
  readRootStructuredFileSync,
  type ReadRootJsonSyncOptions,
  type ReadRootStructuredFileSyncOptions,
} from "../src/json.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempDirs, tempRoot } = useTempDirs();

function inheritedChangingOptions<T extends object>(
  values: Record<string, readonly [unknown, unknown]>,
  own: Record<string, unknown> = {},
): { options: T; reads: Record<string, number> } {
  const prototype: Record<string, unknown> = {};
  const reads: Record<string, number> = {};
  for (const [name, [first, later]] of Object.entries(values)) {
    Object.defineProperty(prototype, name, {
      configurable: true,
      enumerable: false,
      get() {
        const count = (reads[name] ?? 0) + 1;
        reads[name] = count;
        return count === 1 ? first : later;
      },
    });
  }
  return { options: Object.assign(Object.create(prototype), own) as T, reads };
}

describe.runIf(process.platform === "win32")("Windows pathname accessor snapshots", () => {
  it("preserves queue ID validation precedence over aliased directories", async () => {
    const invalidId = "../escape";
    let expectedMessage = "";
    try {
      resolveJsonDurableQueueEntryPaths("C:\\queue", invalidId);
    } catch (error) {
      expectedMessage = (error as Error).message;
    }
    expect(expectedMessage).not.toBe("");
    expect(() => resolveJsonDurableQueueEntryPaths("C:\\queue:hidden", invalidId))
      .toThrow(expectedMessage);

    const lstat = vi.spyOn(fsSync, "lstatSync");
    await expect(moveJsonDurableQueueEntryToFailed({
      queueDir: "C:\\queue:hidden",
      failedDir: "C:\\failed",
      id: invalidId,
    })).rejects.toThrow(expectedMessage);
    await expect(moveJsonDurableQueueEntryToFailed({
      queueDir: "C:\\queue",
      failedDir: "C:\\failed:hidden",
      id: invalidId,
    })).rejects.toThrow(expectedMessage);
    expect(lstat).not.toHaveBeenCalled();
    lstat.mockRestore();
  });

  it.each([
    ["async", fileStore],
    ["sync", fileStoreSync],
  ] as const)("captures an inherited non-enumerable %s FileStore root once", async (_, create) => {
    const root = await tempRoot("fs-safe-store-getter-");
    const { options, reads } = inheritedChangingOptions<FileStoreOptions>({
      rootDir: [root, `${root}::$INDEX_ALLOCATION`],
    });

    const store = create(options);

    expect(store.rootDir).toBe(path.resolve(root));
    expect(reads).toEqual({ rootDir: 1 });
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("captures an inherited non-enumerable jsonStore path once", async () => {
    const root = await tempRoot("fs-safe-json-store-getter-");
    const filePath = path.join(root, "state.json");
    const { options, reads } = inheritedChangingOptions<JsonStoreOptions<{ ok: boolean }>>({
      filePath: [filePath, `${filePath}:hidden`],
    });

    const store = jsonStore<{ ok: boolean }>(options);

    expect(store.filePath).toBe(path.resolve(filePath));
    expect(reads).toEqual({ filePath: 1 });
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it.each(["json", "structured"] as const)(
    "retains inherited non-enumerable root read paths in the %s convenience route",
    async (kind) => {
      const root = await tempRoot("fs-safe-root-json-getter-");
      const rootRealPath = await fs.realpath(root);
      await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ ok: true }));
      const { options, reads } = inheritedChangingOptions<
        ReadRootJsonSyncOptions | ReadRootStructuredFileSyncOptions<{ ok: boolean }>
      >({
        rootDir: [root, `${root}::$INDEX_ALLOCATION`],
        rootRealPath: [rootRealPath, `${rootRealPath}::$INDEX_ALLOCATION`],
        relativePath: ["config.json", "config.json:hidden"],
      }, {
        boundaryLabel: "accessor JSON root",
        parse: (raw: string) => JSON.parse(raw),
      });

      const result = kind === "json"
        ? readRootJsonObjectSync(options as ReadRootJsonSyncOptions)
        : readRootStructuredFileSync(
            options as ReadRootStructuredFileSyncOptions<{ ok: boolean }>,
          );

      expect(result).toMatchObject({ ok: true, value: { ok: true } });
      expect(reads).toEqual({ relativePath: 1, rootDir: 1, rootRealPath: 1 });
    },
  );

  it("returns an immutable owned queue path record after one read per accessor", async () => {
    const root = await tempRoot("fs-safe-queue-path-getter-");
    const paths = resolveJsonDurableQueueEntryPaths(root, "job");
    const { options, reads } = inheritedChangingOptions<DurableQueueEntryPathsLike>({
      jsonPath: [paths.jsonPath, `${paths.jsonPath}:hidden`],
      deliveredPath: [paths.deliveredPath, `${paths.deliveredPath}:hidden`],
      processingPath: [paths.processingPath, `${paths.processingPath}:hidden`],
    });

    const owned = validateDurableQueueEntryPaths(options);

    expect(owned).toEqual(paths);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(reads).toEqual({ deliveredPath: 1, jsonPath: 1, processingPath: 1 });
  });

  it("uses one owned path record through queue claim, read, and callback", async () => {
    const root = await tempRoot("fs-safe-queue-load-getter-");
    const paths = resolveJsonDurableQueueEntryPaths(root, "job");
    await fs.writeFile(paths.jsonPath, JSON.stringify({ ok: true }));
    const pathAccessors = inheritedChangingOptions<DurableQueueEntryPathsLike>({
      jsonPath: [paths.jsonPath, `${paths.jsonPath}:hidden`],
      deliveredPath: [paths.deliveredPath, `${paths.deliveredPath}:hidden`],
      processingPath: [paths.processingPath, `${paths.processingPath}:hidden`],
    });
    const maliciousPaths = {
      jsonPath: `${paths.jsonPath}:hidden`,
      deliveredPath: `${paths.deliveredPath}:hidden`,
      processingPath: `${paths.processingPath}:hidden`,
    };
    const paramsAccessors = inheritedChangingOptions<{
      paths: DurableQueueEntryPathsLike;
      tempPrefix: string;
      read: (entry: { ok: boolean }, filePath: string) => Promise<{ entry: { ok: boolean } }>;
    }>({
      paths: [pathAccessors.options, maliciousPaths],
    }, {
      tempPrefix: "queue",
      read: async (entry: { ok: boolean }, filePath: string) => {
        expect(filePath).toBe(paths.jsonPath);
        return { entry };
      },
    });

    await expect(loadJsonDurableQueueEntry(paramsAccessors.options)).resolves.toEqual({ ok: true });
    expect(paramsAccessors.reads).toEqual({ paths: 1 });
    expect(pathAccessors.reads).toEqual({ deliveredPath: 1, jsonPath: 1, processingPath: 1 });
    await expect(fs.access(`${paths.jsonPath}:hidden`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves missing-queue leniency without evaluating unrelated accessors", async () => {
    const root = await tempRoot("fs-safe-queue-missing-getter-");
    const missingQueue = path.join(root, "missing");
    const paths = resolveJsonDurableQueueEntryPaths(missingQueue, "job");
    const pathAccessors = inheritedChangingOptions<DurableQueueEntryPathsLike>({
      jsonPath: [paths.jsonPath, `${paths.jsonPath}:hidden`],
      deliveredPath: [paths.deliveredPath, `${paths.deliveredPath}:hidden`],
      processingPath: [paths.processingPath, `${paths.processingPath}:hidden`],
    });
    const direct = inheritedChangingOptions<{
      paths: DurableQueueEntryPathsLike;
      tempPrefix: string;
      maxBytes?: number;
    }>({
      paths: [pathAccessors.options, paths],
      tempPrefix: ["queue", "later"],
      maxBytes: [16, 32],
    });
    await expect(loadJsonDurableQueueEntry(direct.options)).resolves.toBeNull();
    expect(direct.reads).toEqual({ paths: 1 });
    expect(pathAccessors.reads).toEqual({ deliveredPath: 1, jsonPath: 1, processingPath: 1 });

    const batch = inheritedChangingOptions<{
      queueDir: string;
      tempPrefix: string;
      maxBytes?: number;
    }>({
      queueDir: [missingQueue, `${missingQueue}::$INDEX_ALLOCATION`],
      tempPrefix: ["queue", "later"],
      maxBytes: [16, 32],
    });
    await expect(loadPendingJsonDurableQueueEntries(batch.options)).resolves.toEqual([]);
    expect(batch.reads).toEqual({ queueDir: 1 });
  });

  it("retains one queue directory snapshot across batch claim, read, and callback", async () => {
    const root = await tempRoot("fs-safe-queue-batch-getter-");
    const queueDir = path.join(root, "queue");
    await fs.mkdir(queueDir);
    await fs.writeFile(path.join(queueDir, "job.json"), JSON.stringify({ id: "job" }));
    let callbackPath: string | undefined;
    const read = async (entry: { id: string }, filePath: string) => {
      callbackPath = filePath;
      return { entry };
    };
    const { options, reads } = inheritedChangingOptions<{
      queueDir: string;
      tempPrefix: string;
      read: typeof read;
      maxBytes?: number;
    }>({
      queueDir: [queueDir, `${queueDir}::$INDEX_ALLOCATION`],
    }, {
      read,
      tempPrefix: "queue",
    });

    await expect(loadPendingJsonDurableQueueEntries(options)).resolves.toEqual([{ id: "job" }]);
    expect(callbackPath).toBe(path.join(queueDir, "job.json"));
    expect(reads).toEqual({ queueDir: 1 });
  });

  it("captures queue directory and id parameters once before directory mutations", async () => {
    // The managed Windows test host denies realpath on part of its user-profile
    // ancestry; durable queue creation intentionally syncs every drive ancestor.
    const root = await fs.mkdtemp(path.join(process.cwd(), ".fs-safe-queue-dir-getter-"));
    tempDirs.push(root);
    const queueDir = path.join(root, "queue");
    const failedDir = path.join(root, "failed");
    const ensureAccessors = inheritedChangingOptions<{ queueDir: string; failedDir: string }>({
      queueDir: [queueDir, `${queueDir}::$INDEX_ALLOCATION`],
      failedDir: [failedDir, `${failedDir}::$INDEX_ALLOCATION`],
    });
    await ensureJsonDurableQueueDirs(ensureAccessors.options);
    expect(ensureAccessors.reads).toEqual({ failedDir: 1, queueDir: 1 });

    const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
    await fs.writeFile(paths.jsonPath, "{}");
    const moveAccessors = inheritedChangingOptions<{
      queueDir: string;
      failedDir: string;
      id: string;
    }>({
      queueDir: [queueDir, `${queueDir}::$INDEX_ALLOCATION`],
      failedDir: [failedDir, `${failedDir}::$INDEX_ALLOCATION`],
      id: ["job", "other"],
    });
    await moveJsonDurableQueueEntryToFailed(moveAccessors.options);

    expect(moveAccessors.reads).toEqual({ failedDir: 1, id: 1, queueDir: 1 });
    await expect(fs.readFile(path.join(failedDir, "job.json"), "utf8")).resolves.toBe("{}");
  });

  it("captures queue write and failed destination pathnames once", async () => {
    const root = await tempRoot("fs-safe-queue-write-getter-");
    const paths = resolveJsonDurableQueueEntryPaths(root, "job");
    const writeAccessors = inheritedChangingOptions<{
      filePath: string;
      entry: unknown;
      tempPrefix: string;
    }>({
      filePath: [paths.jsonPath, `${paths.jsonPath}:hidden`],
    }, {
      entry: { ok: true },
      tempPrefix: "queue",
    });
    await writeJsonDurableQueueEntry(writeAccessors.options);
    expect(writeAccessors.reads).toEqual({ filePath: 1 });

    const failedPath = path.join(root, "failed.json");
    const moveAccessors = inheritedChangingOptions<{
      paths: DurableQueueEntryPathsLike;
      failedPath: string;
    }>({
      failedPath: [failedPath, `${failedPath}:hidden`],
    }, {
      paths,
    });
    await moveDurableQueueEntryToFailed(moveAccessors.options);

    expect(moveAccessors.reads).toEqual({ failedPath: 1 });
    await expect(fs.readFile(failedPath, "utf8")).resolves.toContain('"ok": true');
    await expect(fs.access(`${failedPath}:hidden`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
