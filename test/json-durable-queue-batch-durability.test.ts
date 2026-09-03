import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import {
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  resolveJsonDurableQueueEntryPaths,
} from "../src/json-durable-queue.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { itPosix, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const oldBytes = '{"version":1}';
const migrated = { version: 2 };
const migrate = async () => ({ entry: migrated, migrated: true });
const ioFailure = () => Object.assign(new Error("injected sync failure"), { code: "EIO" });

beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
});

afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative({ mode: "auto" });
  Object.defineProperty(process, "platform", platform);
});

async function fixture(processing = false) {
  const queueDir = await tempRoot("fs-safe-queue-batch-durability-");
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
  await fs.writeFile(processing ? paths.processingPath! : paths.jsonPath, oldBytes);
  const options = { queueDir, tempPrefix: "queue" };
  return { queueDir, paths, options, load: () => loadPendingJsonDurableQueueEntries(options) };
}

// Target the opened descriptor, as in the queue durability suite; unrelated
// file and lock operations keep their real behavior throughout each injection.
function failSyncOnce(matches: (openedPath: string) => boolean, failure: Error, occurrence = 1) {
  const realOpen = fs.open.bind(fs);
  let calls = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (!matches(path.resolve(args[0].toString()))) return handle;
    const realSync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      if (++calls === occurrence) throw failure;
      await realSync();
    });
    return handle;
  });
  return () => calls;
}

async function expectClaimLinks(jsonPath: string, processingPath: string) {
  const pending = await fs.lstat(jsonPath, { bigint: true });
  expect(pending.nlink).toBe(2n);
  await expect(fs.lstat(processingPath, { bigint: true })).resolves.toMatchObject({
    dev: pending.dev, ino: pending.ino, nlink: 2n,
  });
}

describe("batch queue transition failures", () => {
  it.each([1, 2])("propagates directory sync failure %i after linking and retries retirement", async (occurrence) => {
    const { queueDir, paths, load } = await fixture();
    const failure = ioFailure();
    const calls = failSyncOnce((openedPath) => openedPath === queueDir, failure, occurrence);

    await expect(load()).rejects.toBe(failure);
    expect(calls()).toBe(occurrence);
    await expectClaimLinks(paths.jsonPath, paths.processingPath!);
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe(oldBytes);

    vi.restoreAllMocks();
    await expect(load()).resolves.toEqual([{ version: 1 }]);
    await expect(fs.access(paths.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(paths.processingPath!, { bigint: true })).resolves.toMatchObject({ nlink: 1n });
  });

  it("propagates transfer-lock acquisition failures without claiming the entry", async () => {
    const { paths, load } = await fixture();
    const failure = Object.assign(new Error("lock denied"), { code: "EACCES" });
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (path.basename(args[0].toString()).startsWith(".fs-safe-transfer-")) throw failure;
      return await realOpen(...args);
    });

    await expect(load()).rejects.toBe(failure);
    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toBe(oldBytes);
    await expect(fs.access(paths.processingPath!)).rejects.toMatchObject({ code: "ENOENT" });
    vi.restoreAllMocks();
    await expect(load()).resolves.toEqual([{ version: 1 }]);
  });

  it("propagates post-link path-mismatch errors instead of skipping them", async () => {
    const { paths, load } = await fixture();
    const failure = new FsSafeError("path-mismatch", "injected claim validation failure");
    const realLink = fs.link.bind(fs);
    const realLstat = fs.lstat.bind(fs);
    let linked = false;
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (target === paths.processingPath) linked = true;
    });
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (linked && args[0] === paths.processingPath) throw failure;
      return await realLstat(...args);
    });

    await expect(load()).rejects.toBe(failure);
    expect(linked).toBe(true);
    vi.restoreAllMocks();
    await expectClaimLinks(paths.jsonPath, paths.processingPath!);
    await expect(load()).resolves.toEqual([{ version: 1 }]);
  });

  it("rejects an extra hardlink introduced across the claim boundary", async () => {
    const { queueDir, paths, load } = await fixture();
    const extraPath = path.join(queueDir, "extra-link");
    const realLink = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (target === paths.processingPath) await realLink(target, extraPath);
    });

    await expect(load()).rejects.toMatchObject({ code: "path-mismatch" });
    await expect(fs.lstat(paths.jsonPath, { bigint: true })).resolves.toMatchObject({ nlink: 3n });
    await expect(fs.readFile(extraPath, "utf8")).resolves.toBe(oldBytes);
  });

  it("rejects after an earlier entry succeeds while retaining both claims for retry", async () => {
    const { queueDir, paths, load } = await fixture();
    const earlier = resolveJsonDurableQueueEntryPaths(queueDir, "earlier");
    await fs.writeFile(earlier.jsonPath, '{"version":0}');
    const realReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === queueDir) return ["earlier.json", "job.json"];
      return await realReaddir(...args);
    });
    const failure = ioFailure();
    const realLink = fs.link.bind(fs);
    vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (target === paths.processingPath) {
        failSyncOnce((openedPath) => openedPath === queueDir, failure);
      }
    });

    await expect(load()).rejects.toBe(failure);
    await expect(fs.readFile(earlier.processingPath!, "utf8")).resolves.toBe('{"version":0}');
    await expect(fs.access(earlier.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(earlier.deliveredPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectClaimLinks(paths.jsonPath, paths.processingPath!);
    vi.restoreAllMocks();
    await expect(load()).resolves.toEqual([{ version: 0 }, { version: 1 }]);
  });
});

describe("queue migration durability", () => {
  it("rejects staged file sync failure with old processing bytes intact and retries", async () => {
    const { paths, options } = await fixture(true);
    const failure = ioFailure();
    const calls = failSyncOnce((openedPath) => openedPath.endsWith(".tmp"), failure);
    const load = () => loadPendingJsonDurableQueueEntries({ ...options, read: migrate });

    await expect(load()).rejects.toBe(failure);
    expect(calls()).toBe(1);
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe(oldBytes);
    vi.restoreAllMocks();
    await expect(load()).resolves.toEqual([migrated]);
    expect(JSON.parse(await fs.readFile(paths.processingPath!, "utf8"))).toEqual(migrated);
  });

  it.each(["batch", "single"] as const)("%s rejects post-publication directory sync failure and resyncs on retry", async (loader) => {
    const { queueDir, paths, options } = await fixture(true);
    const failure = ioFailure();
    const calls = failSyncOnce((openedPath) => openedPath === queueDir, failure);
    const load = () => loader === "batch"
      ? loadPendingJsonDurableQueueEntries({ ...options, read: migrate })
      : loadJsonDurableQueueEntry({ paths, tempPrefix: "queue", read: migrate });

    await expect(load()).rejects.toBe(failure);
    expect(calls()).toBe(1);
    expect(JSON.parse(await fs.readFile(paths.processingPath!, "utf8"))).toEqual(migrated);
    await expect(fs.access(paths.jsonPath)).rejects.toMatchObject({ code: "ENOENT" });

    vi.restoreAllMocks();
    const retrySyncs = failSyncOnce((openedPath) => openedPath === queueDir, failure, Infinity);
    await expect(load()).resolves.toEqual(loader === "batch" ? [migrated] : migrated);
    expect(retrySyncs()).toBe(1);
    expect(JSON.parse(await fs.readFile(paths.processingPath!, "utf8"))).toEqual(migrated);
  });

  it.each(["write", "rename", "verify"] as const)("propagates migration %s failures unchanged", async (stage) => {
    const { paths, options } = await fixture(true);
    const failure = ioFailure();
    const realWrite = fs.writeFile.bind(fs);
    const realRename = fs.rename.bind(fs);
    const realLstat = fs.lstat.bind(fs);
    let published = false;
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (stage === "write" && typeof args[0] === "object" && "fd" in args[0]) throw failure;
      return await realWrite(...args);
    });
    vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
      if (target === paths.processingPath && stage === "rename") throw failure;
      await realRename(source, target);
      if (target === paths.processingPath) published = true;
    });
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (stage === "verify" && published && args[0] === paths.processingPath) throw failure;
      return await realLstat(...args);
    });
    const load = () => loadPendingJsonDurableQueueEntries({ ...options, read: migrate });

    await expect(load()).rejects.toBe(failure);
    expect(published).toBe(stage === "verify");
    expect(JSON.parse(await fs.readFile(paths.processingPath!, "utf8"))).toEqual(
      published ? migrated : { version: 1 },
    );
    vi.restoreAllMocks();
    await expect(load()).resolves.toEqual([migrated]);
  });
});

describe("batch entry skip boundary", () => {
  it("skips initially hardlinked pending entries without changing either link", async () => {
    const { queueDir, paths, options, load } = await fixture();
    const alias = path.join(queueDir, "unowned-link");
    await fs.link(paths.jsonPath, alias);
    const initial = await fs.lstat(paths.jsonPath, { bigint: true });

    await expect(load()).resolves.toEqual([]);
    await expectClaimLinks(paths.jsonPath, alias);
    await expect(fs.lstat(paths.jsonPath, { bigint: true })).resolves.toMatchObject({ ino: initial.ino });
    await expect(fs.readFile(alias, "utf8")).resolves.toBe(oldBytes);
    await expect(fs.access(paths.processingPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(loadJsonDurableQueueEntry({ paths, tempPrefix: options.tempPrefix }))
      .rejects.toMatchObject({ code: "path-mismatch" });
  });

  it("skips unverifiable initial pending identity while the single loader still rejects", async () => {
    const { paths, load } = await fixture();
    Object.defineProperty(process, "platform", { value: "win32" });
    const realLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await realLstat(...args);
      if (args[0] === paths.jsonPath) Object.assign(stat, { ino: 0n });
      return stat;
    });
    const link = vi.spyOn(fs, "link");

    await expect(load()).resolves.toEqual([]);
    expect(link).not.toHaveBeenCalled();
    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toBe(oldBytes);
    await expect(fs.access(paths.processingPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(loadJsonDurableQueueEntry({ paths, tempPrefix: "queue" }))
      .rejects.toMatchObject({ code: "path-mismatch" });
  });

  it("skips read identity failures after claiming without deleting owned state", async () => {
    const { paths, load } = await fixture(true);
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === paths.processingPath) {
        const realStat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
          const stat = await realStat(...statArgs);
          return Object.assign(stat, { ino: BigInt(stat.ino) + 1n });
        });
      }
      return handle;
    });

    await expect(load()).resolves.toEqual([]);
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe(oldBytes);
    vi.restoreAllMocks();
    await expect(load()).resolves.toEqual([{ version: 1 }]);
  });

  it("keeps mixed valid entries in listing order while skipping bad content and callbacks", async () => {
    const { queueDir, paths } = await fixture(true);
    await fs.writeFile(paths.jsonPath, '{"version":99}');
    await fs.writeFile(path.join(queueDir, "z.json"), '{"version":3}');
    await fs.writeFile(path.join(queueDir, "bad.json"), "{");
    await fs.writeFile(path.join(queueDir, "large.json"), JSON.stringify("x".repeat(100)));
    await fs.writeFile(path.join(queueDir, "callback.json"), '{"version":4}');
    await fs.mkdir(path.join(queueDir, "directory.json"));
    const realReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (args[0] === queueDir) {
        return ["z.json", "bad.json", "large.json", "directory.json", "callback.json", "job.json", "job.processing", "absent.json"];
      }
      return await realReaddir(...args);
    });
    const read = vi.fn(async (entry: { version: number }, filePath: string) => {
      if (filePath.endsWith("callback.json")) throw ioFailure();
      return { entry };
    });

    await expect(loadPendingJsonDurableQueueEntries({ queueDir, tempPrefix: "queue", maxBytes: 32, read }))
      .resolves.toEqual([{ version: 3 }, { version: 1 }]);
    expect(read.mock.calls.map(([, filePath]) => path.basename(filePath)))
      .toEqual(["z.json", "callback.json", "job.json"]);
    await expect(fs.readFile(path.join(queueDir, "bad.processing"), "utf8")).resolves.toBe("{");
    await expect(fs.readFile(path.join(queueDir, "callback.processing"), "utf8")).resolves.toBe('{"version":4}');
    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toBe('{"version":99}');
  });

  itPosix("skips a pending symlink without changing its target", async () => {
    const { queueDir, paths, load } = await fixture(true);
    const target = path.join(queueDir, "target");
    await fs.rename(paths.processingPath!, target);
    await fs.symlink(target, paths.jsonPath);

    await expect(load()).resolves.toEqual([]);
    await expect(fs.readlink(paths.jsonPath)).resolves.toBe(target);
    await expect(fs.readFile(target, "utf8")).resolves.toBe(oldBytes);
    await expect(fs.access(paths.processingPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
