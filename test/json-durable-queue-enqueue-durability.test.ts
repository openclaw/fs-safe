import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureJsonDurableQueueDirs,
  resolveJsonDurableQueueEntryPaths,
  writeJsonDurableQueueEntry,
} from "../src/json-durable-queue.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture(existing = false) {
  const root = await fs.realpath(await tempRoot("fs-safe-queue-enqueue-durability-"));
  const queueDir = path.join(root, "queue");
  await ensureJsonDurableQueueDirs({ queueDir, failedDir: path.join(root, "failed") });
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
  if (existing) await fs.writeFile(paths.jsonPath, '{"generation":1}\n', { mode: 0o600 });
  const write = () => writeJsonDurableQueueEntry({
    filePath: paths.jsonPath,
    entry: { generation: 2 },
    tempPrefix: "queue",
  });
  return { queueDir, paths, write };
}

function observeWrite(filePath: string, failAt?: "temp-sync" | "parent-sync" | "parent-open", failure?: Error) {
  const events: string[] = [];
  const realOpen = fs.open.bind(fs);
  const realRename = fs.rename.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    if (failAt === "parent-open" && events.includes("publish") && args[0].toString() === path.dirname(filePath)) {
      throw failure;
    }
    const handle = await realOpen(...args);
    const realSync = handle.sync.bind(handle);
    const event = (await handle.stat()).isDirectory() ? "parent-sync" : "temp-sync";
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      events.push(event);
      if (event === failAt) throw failure;
      await realSync();
    });
    return handle;
  });
  vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    await realRename(source, target);
    if (target === filePath) events.push("publish");
  });
  return events;
}

describe("durable JSON queue enqueue durability", () => {
  it("syncs the temp file, publishes, then syncs the parent exactly once", async () => {
    const { paths, write } = await fixture();
    const events = observeWrite(paths.jsonPath);

    await write();

    expect(events).toEqual(["temp-sync", "publish", "parent-sync"]);
    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toBe('{\n  "generation": 2\n}');
    if (process.platform !== "win32") {
      expect((await fs.stat(paths.jsonPath)).mode & 0o777).toBe(0o600);
    }
  });

  it.each([false, true])("propagates parent sync errors and retries after publication (existing=%s)", async (existing) => {
    const { queueDir, paths, write } = await fixture(existing);
    for (const phase of ["initial", "retry"]) {
      const failure = Object.assign(new Error(`${phase} enqueue directory sync failed`), { code: "EIO" });
      const events = observeWrite(paths.jsonPath, "parent-sync", failure);

      await expect(write()).rejects.toBe(failure);

      expect(events).toEqual(["temp-sync", "publish", "parent-sync"]);
      await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toBe('{\n  "generation": 2\n}');
      await expect(fs.readdir(queueDir)).resolves.toEqual(["job.json"]);
      vi.restoreAllMocks();
    }
    const events = observeWrite(paths.jsonPath);
    await expect(write()).resolves.toBeUndefined();
    expect(events).toEqual(["temp-sync", "publish", "parent-sync"]);
    await expect(fs.readdir(queueDir)).resolves.toEqual(["job.json"]);
  });

  it.each([false, true])("does not publish or leak a temp file after temp sync failure (existing=%s)", async (existing) => {
    const { queueDir, paths, write } = await fixture(existing);
    const failure = Object.assign(new Error("enqueue temp sync failed"), { code: "EIO" });
    const events = observeWrite(paths.jsonPath, "temp-sync", failure);

    await expect(write()).rejects.toBe(failure);

    expect(events).toEqual(["temp-sync"]);
    await expect(fs.readdir(queueDir)).resolves.toEqual(existing ? ["job.json"] : []);
    if (existing) {
      await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toBe('{"generation":1}\n');
    }
  });

  it.each(["EIO", "EACCES"])("propagates parent open %s after publication", async (code) => {
    const { queueDir, paths, write } = await fixture();
    const failure = Object.assign(new Error("enqueue parent open failed"), { code });
    const events = observeWrite(paths.jsonPath, "parent-open", failure);

    await expect(write()).rejects.toBe(failure);

    expect(events).toEqual(["temp-sync", "publish"]);
    await expect(fs.readFile(paths.jsonPath, "utf8")).resolves.toBe('{\n  "generation": 2\n}');
    await expect(fs.readdir(queueDir)).resolves.toEqual(["job.json"]);
  });
});
