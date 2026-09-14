import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  resolveJsonDurableQueueEntryPaths,
  type JsonDurableQueueReadResult,
} from "../src/json-durable-queue.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

type Entry = { generation: number; migrated?: boolean };
type Loader = "single" | "batch";
type Read = (entry: Entry) => Promise<JsonDurableQueueReadResult<Entry>>;
type TrackedRead = { handle: FileHandle; closed: boolean; closeCalls: number };

const { tempRoot } = useRealTempDirs();
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatform);
  configureFsSafeNative({ mode: "auto" });
});

async function fixture(loader: Loader) {
  const queueDir = await tempRoot("fs-safe-queue-windows-publication-");
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
  const processingBytes = '{"generation":1}';
  const pendingBytes = '{"generation":2}';
  await fs.writeFile(paths.processingPath!, processingBytes);
  await fs.writeFile(paths.jsonPath, pendingBytes);
  const identity = await fs.lstat(paths.processingPath!, { bigint: true });
  Object.defineProperty(process, "platform", { value: "win32" });
  const load = (read: Read) => loader === "single"
    ? loadJsonDurableQueueEntry<Entry>({ paths, tempPrefix: "queue", read })
    : loadPendingJsonDurableQueueEntries<Entry>({ queueDir, tempPrefix: "queue", read });
  return { queueDir, paths, processingBytes, pendingBytes, identity, load };
}

function expectOpen(record: TrackedRead) {
  expect(record.closed).toBe(false);
  expect(record.closeCalls).toBe(0);
  expect(record.handle.fd).toBeGreaterThanOrEqual(0);
  expect(fsSync.fstatSync(record.handle.fd).isFile()).toBe(true);
}

function expectClosed(record: TrackedRead) {
  expect(record.closed).toBe(true);
  expect(record.closeCalls).toBe(1);
  expect(record.handle.fd).toBe(-1);
}

function trackProcessingRead(
  processingPath: string,
  events: string[],
  afterClose?: () => Promise<void>,
) {
  const records: TrackedRead[] = [];
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const filePath = path.resolve(args[0].toString());
    const flags = args[1];
    const readOnly = flags === "r" || (typeof flags === "number" &&
      (flags & (fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR)) === 0);
    if (filePath === processingPath && readOnly) {
      const record: TrackedRead = { handle, closed: false, closeCalls: 0 };
      records.push(record);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        record.closeCalls++;
        await close();
        record.closed = true;
        events.push("read-closed");
        await afterClose?.();
      });
    } else if (filePath.endsWith(".tmp")) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        expectOpen(records[0]!);
        await sync();
        events.push("staged");
      });
    }
    return handle;
  });
  return records;
}

async function expectOriginalFiles(subject: Awaited<ReturnType<typeof fixture>>) {
  await expect(fs.readFile(subject.paths.processingPath!, "utf8"))
    .resolves.toBe(subject.processingBytes);
  await expect(fs.readFile(subject.paths.jsonPath, "utf8")).resolves.toBe(subject.pendingBytes);
  await expect(fs.lstat(subject.paths.processingPath!, { bigint: true })).resolves.toMatchObject({
    dev: subject.identity.dev, ino: subject.identity.ino, nlink: 1n,
  });
  expect((await fs.readdir(subject.queueDir)).sort()).toEqual(["job.json", "job.processing"]);
}

describe.each(["single", "batch"] as const)("%s Windows queue migration publication", (loader) => {
  it("releases its read pin once after staging and rechecks the target before rename", async () => {
    const { paths, pendingBytes, load } = await fixture(loader);
    const events: string[] = [];
    const lstat = vi.spyOn(fsSync, "lstatSync");
    let observationsAtClose = -1;
    const records = trackProcessingRead(paths.processingPath!, events, async () => {
      await Promise.resolve();
      observationsAtClose = lstat.mock.calls.length;
      events.push("close-settled");
    });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === paths.processingPath) {
        expectClosed(records[0]!);
        expect(observationsAtClose).toBeGreaterThanOrEqual(0);
        expect(lstat.mock.calls.slice(observationsAtClose)).toContainEqual([
          paths.processingPath, { bigint: true },
        ]);
        events.push("rename");
      }
      await rename(source, destination);
    });
    const migrated = { generation: 1, migrated: true };

    await expect(load(async (entry) => {
      expectOpen(records[0]!);
      events.push("callback");
      return { entry: { ...entry, migrated: true }, migrated: true };
    })).resolves.toEqual(loader === "single" ? migrated : [migrated]);

    expect(records).toHaveLength(1);
    expectClosed(records[0]!);
    expect(events).toEqual(["callback", "staged", "read-closed", "close-settled", "rename"]);
    expect(JSON.parse(await fs.readFile(paths.processingPath!, "utf8"))).toEqual(migrated);
    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toBe(pendingBytes);
  });

  it.each(["swap", "recreate"] as const)("rejects a processing %s during asynchronous close", async (change) => {
    const { queueDir, paths, processingBytes, pendingBytes, load } = await fixture(loader);
    const replacementPath = path.join(queueDir, "replacement");
    const savedPath = path.join(queueDir, "saved");
    const replacementBytes = '{"generation":3}';
    await fs.writeFile(replacementPath, replacementBytes);
    const replacementIdentity = await fs.lstat(replacementPath, { bigint: true });
    const rename = fs.rename.bind(fs);
    const records = trackProcessingRead(paths.processingPath!, [], async () => {
      await Promise.resolve();
      if (change === "swap") await rename(paths.processingPath!, savedPath);
      else await fs.unlink(paths.processingPath!);
      await rename(replacementPath, paths.processingPath!);
    });
    const publication = vi.spyOn(fs, "rename");

    await expect(load(async (entry) => {
      expectOpen(records[0]!);
      return { entry: { ...entry, migrated: true }, migrated: true };
    })).rejects.toMatchObject({ code: "path-mismatch" });

    expect(records).toHaveLength(1);
    expectClosed(records[0]!);
    expect(publication).not.toHaveBeenCalled();
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe(replacementBytes);
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({
      dev: replacementIdentity.dev, ino: replacementIdentity.ino, nlink: 1n,
    });
    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toBe(pendingBytes);
    if (change === "swap") await expect(fs.readFile(savedPath, "utf8")).resolves.toBe(processingBytes);
    expect((await fs.readdir(queueDir)).sort()).toEqual([
      "job.json", "job.processing", ...(change === "swap" ? ["saved"] : []),
    ]);
  });

  it("propagates a close failure once without attempting publication", async () => {
    const subject = await fixture(loader);
    const failure = Object.assign(new Error("queue read close failed"), { code: "EIO" });
    const records = trackProcessingRead(subject.paths.processingPath!, [], async () => {
      throw failure;
    });
    const publication = vi.spyOn(fs, "rename");

    await expect(subject.load(async (entry) => {
      expectOpen(records[0]!);
      return { entry: { ...entry, migrated: true }, migrated: true };
    })).rejects.toBe(failure);

    expect(records).toHaveLength(1);
    expectClosed(records[0]!);
    expect(publication).not.toHaveBeenCalled();
    await expectOriginalFiles(subject);
  });

  it("propagates another reader's sharing denial without closing that reader", async () => {
    const subject = await fixture(loader);
    const other = await fs.open(subject.paths.processingPath!, "r");
    const otherClose = vi.spyOn(other, "close");
    const records = trackProcessingRead(subject.paths.processingPath!, []);
    const failure = Object.assign(new Error("another reader prevents replacement"), { code: "EPERM" });
    const rename = fs.rename.bind(fs);
    const publication = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === subject.paths.processingPath) {
        expectClosed(records[0]!);
        expect(other.fd).toBeGreaterThanOrEqual(0);
        throw failure;
      }
      await rename(source, destination);
    });
    try {
      await expect(subject.load(async (entry) => {
        expectOpen(records[0]!);
        expect(other.fd).toBeGreaterThanOrEqual(0);
        return { entry: { ...entry, migrated: true }, migrated: true };
      })).rejects.toBe(failure);

      expect(records).toHaveLength(1);
      expectClosed(records[0]!);
      expect(publication).toHaveBeenCalledTimes(1);
      expect(otherClose).not.toHaveBeenCalled();
      expect(fsSync.fstatSync(other.fd).isFile()).toBe(true);
      await expectOriginalFiles(subject);
    } finally {
      await other.close();
    }
  });
});
