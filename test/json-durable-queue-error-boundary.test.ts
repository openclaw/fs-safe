import fsSync from "node:fs";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadJsonDurableQueueEntry, loadPendingJsonDurableQueueEntries, resolveJsonDurableQueueEntryPaths } from "../src/json-durable-queue.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });

async function fixture() {
  const queueDir = await tempRoot("fs-safe-queue-error-boundary-");
  const paths = resolveJsonDurableQueueEntryPaths(queueDir, "job");
  await fs.writeFile(paths.processingPath!, '{"version":1}\n');
  return { queueDir, paths, options: { paths, tempPrefix: "queue" } };
}

describe("queue missing-entry error boundary", () => {
  it.each(["callback", "read getter", "result getter", "budget getter"])(
    "propagates ENOENT from a %s unchanged", async boundary => {
      const { paths, options } = await fixture();
      const failure = Object.assign(new Error("auxiliary input missing"), { code: "ENOENT" });
      const read = vi.fn(async function(this: unknown) {
        expect(this).toBe(options);
        if (boundary === "callback") throw failure;
        return { get entry() { throw failure; } };
      });
      if (boundary === "read getter" || boundary === "budget getter") {
        Object.defineProperty(options, boundary === "read getter" ? "read" : "maxBytes", {
          get() { expect(this).toBe(options); throw failure; },
        });
      } else Object.assign(options, { read });
      await expect(loadJsonDurableQueueEntry(options)).rejects.toBe(failure);
      await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe('{"version":1}\n');
      await expect(fs.access(paths.deliveredPath!)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps ordinary batch callback errors skippable", async () => {
    const { queueDir, paths } = await fixture();
    const failure = { code: "ENOENT", marker: "caller" };
    await expect(loadPendingJsonDurableQueueEntries({
      queueDir, tempPrefix: "queue", read: async () => { throw failure; },
    })).resolves.toEqual([]);
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe('{"version":1}\n');
  });

  it.each(["claim", "migration"])("propagates an owned %s sync failure", async boundary => {
    const { queueDir, paths, options } = await fixture();
    const failure = Object.assign(new Error("owned sync failed"), { code: "ENOENT" });
    const read = vi.fn(async () => ({ entry: { version: 2 }, migrated: true }));
    let injected = false;
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (boundary === "claim" ? args[0] === queueDir : String(args[0]).endsWith(".tmp")) {
        vi.spyOn(handle, "sync").mockImplementation(async () => { injected = true; throw failure; });
      }
      return handle;
    });
    await expect(loadJsonDurableQueueEntry({ ...options, read })).rejects.toBe(failure);
    expect(injected).toBe(true);
    expect(read).toHaveBeenCalledTimes(boundary === "claim" ? 0 : 1);
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe('{"version":1}\n');
    vi.restoreAllMocks();
    await expect(loadJsonDurableQueueEntry({ ...options, read })).resolves.toEqual({ version: 2 });
  });

  it("keeps a processing file removed before read-open nullable", async () => {
    const { paths, options } = await fixture();
    const read = vi.fn(async (entry: unknown) => ({ entry }));
    const open = fs.open;
    let removed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (args[0] === paths.processingPath) {
        fsSync.unlinkSync(paths.processingPath!);
        removed = true;
      }
      return await open(...args);
    });
    await expect(loadJsonDurableQueueEntry({ ...options, read })).resolves.toBeNull();
    expect(removed).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});
