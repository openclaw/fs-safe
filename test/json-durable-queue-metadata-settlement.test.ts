import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as directoryDurability from "../src/directory-durability.js";
import { configureFsSafeNative } from "../src/native-config.js";
import {
  ackJsonDurableQueueEntry,
  ensureJsonDurableQueueDirs,
  loadJsonDurableQueueEntry,
  moveJsonDurableQueueEntryToFailed,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
} from "../src/store.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
});

async function fixture() {
  const directory = await tempRoot("fs-safe-queue-metadata-");
  const queueDir = path.join(directory, "queue");
  const failedDir = path.join(directory, "failed");
  await ensureJsonDurableQueueDirs({ queueDir, failedDir });
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
  return { directory, queueDir, failedDir, paths };
}

it.each([
  { label: "EACCES", failure: Object.assign(new Error("claim metadata denied"), { code: "EACCES" }) },
  { label: "undefined", failure: undefined },
  { label: "null", failure: null },
  { label: "false", failure: false },
  { label: "zero", failure: 0 },
  { label: "empty string", failure: "" },
])("settles a $label metadata failure without acknowledging either generation", async ({ failure }) => {
  const { queueDir, paths } = await fixture();
  await writeJsonDurableQueueEntry({ filePath: paths.jsonPath, entry: { generation: 1 }, tempPrefix: "queue" });
  await loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" });
  await writeJsonDurableQueueEntry({ filePath: paths.jsonPath, entry: { generation: 2 }, tempPrefix: "queue" });
  const before = await fs.readdir(queueDir);
  const pending = await fs.readFile(paths.jsonPath);
  const processing = await fs.readFile(paths.processingPath!);
  const lstat = fsSync.lstatSync.bind(fsSync);
  let failed = false;
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    if (!failed && args[0] === paths.processingPath) {
      failed = true;
      throw failure;
    }
    return lstat(...args);
  });

  await expect(ackJsonDurableQueueEntry(paths)).rejects.toBe(failure);
  expect(failed).toBe(true);
  expect(await fs.readdir(queueDir)).toEqual(before);
  expect(await fs.readFile(paths.processingPath!)).toEqual(processing);
  expect(await fs.readFile(paths.jsonPath)).toEqual(pending);

  vi.restoreAllMocks();
  await expect(ackJsonDurableQueueEntry(paths)).resolves.toBeUndefined();
  await expect(fs.access(paths.processingPath!)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(paths.jsonPath)).toEqual(pending);
});

it("rejects replaced failed evidence after retry synchronization without consuming the pending generation", async () => {
  const { directory, queueDir, failedDir, paths } = await fixture();
  const failedPath = path.join(failedDir, "job.json");
  const displaced = path.join(directory, "displaced.json");
  const replacement = path.join(directory, "replacement.json");
  await fs.writeFile(failedPath, '{"generation":1}');
  await fs.writeFile(paths.jsonPath, '{"generation":2}');
  await fs.writeFile(replacement, '{"generation":3}');
  const replacementIdentity = await fs.lstat(replacement, { bigint: true });
  const failedReal = await fs.realpath(failedDir);
  const syncDirectory = directoryDurability.syncDirectory;
  const lstat = fsSync.lstatSync.bind(fsSync);
  let observedFailed = false;
  let replaced = false;
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (args[0] === failedPath) observedFailed = true;
    return stat;
  });
  vi.spyOn(directoryDurability, "syncDirectory").mockImplementation(async (...args) => {
    const outcome = await syncDirectory(...args);
    const target = typeof args[0] === "string" ? args[0] : args[0].path;
    // Recovery must recheck evidence after supported or unsupported directory sync.
    if (observedFailed && !replaced && [path.resolve(failedDir), failedReal].includes(path.resolve(target))) {
      replaced = true;
      await fs.rename(failedPath, displaced);
      await fs.rename(replacement, failedPath);
    }
    return outcome;
  });

  await expect(moveJsonDurableQueueEntryToFailed({ queueDir, failedDir, id: "job" }))
    .rejects.toMatchObject({ code: "path-mismatch", message: "failed queue destination changed during recovery" });
  expect(replaced).toBe(true);
  expect(await fs.readFile(displaced, "utf8")).toBe('{"generation":1}');
  expect(await fs.readFile(paths.jsonPath, "utf8")).toBe('{"generation":2}');
  expect(await fs.readFile(failedPath, "utf8")).toBe('{"generation":3}');
  expect(await fs.lstat(failedPath, { bigint: true })).toMatchObject({
    dev: replacementIdentity.dev, ino: replacementIdentity.ino,
  });
  expect(await fs.readdir(queueDir)).toEqual(["job.json"]);
});
