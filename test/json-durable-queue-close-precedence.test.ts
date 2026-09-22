import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadJsonDurableQueueEntry,
  loadPendingJsonDurableQueueEntries,
  readJsonDurableQueueEntry,
  resolveJsonDurableQueueEntryPaths,
} from "../src/json-durable-queue.js";
import { configureFsSafeNative } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const falsyFailures = [undefined, null, false, 0, -0, 0n, NaN, ""];
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => { vi.restoreAllMocks(); configureFsSafeNative({ mode: "auto" }); });

// Start a real close before injecting failure; join it before assertions so
// synchronous adapter throws cannot leak descriptors or rely on disk failure.
function observeReadClose(
  filePath: string,
  closeFailure?: { value: unknown; mode: "reject" | "throw" },
  onOpen?: (openedPath: string, handle: fs.FileHandle) => void,
) {
  const records: { handle: fs.FileHandle; close: ReturnType<typeof vi.fn>; closed: Promise<void>[] }[] = [];
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === filePath) {
      const actualClose = handle.close.bind(handle);
      const closed: Promise<void>[] = [];
      const close = vi.spyOn(handle, "close").mockImplementation(() => {
        const pendingClose = actualClose();
        closed.push(pendingClose);
        if (closeFailure?.mode === "throw") throw closeFailure.value;
        return pendingClose.then(() => { if (closeFailure) throw closeFailure.value; });
      });
      records.push({ handle, close, closed });
    }
    onOpen?.(String(args[0]), handle);
    return handle;
  });
  return records;
}

async function expectClosed(records: ReturnType<typeof observeReadClose>) {
  expect(records).toHaveLength(1);
  expect(records[0]!.close).toHaveBeenCalledTimes(1);
  await Promise.all(records[0]!.closed);
  expect(records[0]!.handle.fd).toBe(-1);
}

function settled<T>(operation: Promise<T>) {
  return operation.then(
    value => ({ rejected: false as const, value }),
    reason => ({ rejected: true as const, reason: reason as unknown }),
  );
}

describe.each(["reject", "throw"] as const)("durable queue close-error precedence (%s)", mode => {
  it.each(["descriptor", "read"] as const)("preserves a %s failure when close also rejects", async boundary => {
    const directory = await tempRoot("fs-safe-queue-close-precedence-");
    const filePath = path.join(directory, "entry.json");
    await fs.writeFile(filePath, "{}");
    const primary = Object.assign(new Error(`${boundary} failed`), { code: "EACCES" });
    const closeFailure = Object.assign(new Error("read close failed"), { code: "EIO" });
    const records = observeReadClose(filePath, { value: closeFailure, mode });
    const stat = fsSync.fstatSync.bind(fsSync);
    vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
      if (fd === records[0]?.handle.fd) {
        if (boundary === "descriptor") throw primary;
        vi.spyOn(records[0]!.handle, "read").mockRejectedValue(primary);
      }
      return stat(fd, options);
    });

    const outcome = await settled(readJsonDurableQueueEntry(filePath));

    await expectClosed(records);
    expect(outcome.rejected).toBe(true);
    expect("reason" in outcome && outcome.reason).toBe(primary);
  });

  it("preserves the parse failure from malformed bytes when close also rejects", async () => {
    const directory = await tempRoot("fs-safe-queue-close-parse-");
    const filePath = path.join(directory, "entry.json");
    await fs.writeFile(filePath, "{");
    const records = observeReadClose(filePath, { value: new Error("read close failed"), mode });

    const outcome = await settled(readJsonDurableQueueEntry(filePath));

    await expectClosed(records);
    expect(outcome.rejected).toBe(true);
    expect("reason" in outcome && outcome.reason).toBeInstanceOf(SyntaxError);
  });

  it.each(falsyFailures)("preserves a falsy callback rejection (%s) when close also rejects", async primary => {
    const directory = await tempRoot("fs-safe-queue-close-callback-");
    const paths = resolveJsonDurableQueueEntryPaths(directory, "job");
    await fs.writeFile(paths.processingPath!, "{}");
    const records = observeReadClose(paths.processingPath!, { value: new Error("read close failed"), mode });

    const outcome = await settled(loadJsonDurableQueueEntry({
      paths, tempPrefix: "queue", read: async () => { throw primary; },
    }));

    await expectClosed(records);
    expect(outcome.rejected).toBe(true);
    expect("reason" in outcome && outcome.reason).toBe(primary);
  });

  it.each(["single", "batch"] as const)("preserves a %s migration failure when close also rejects", async loader => {
    const directory = await tempRoot("fs-safe-queue-close-migration-");
    const paths = resolveJsonDurableQueueEntryPaths(directory, "job");
    await fs.writeFile(paths.processingPath!, "{}");
    const primary = Object.assign(new Error("migration staging sync failed"), { code: "EIO" });
    let injected = false;
    const records = observeReadClose(paths.processingPath!, { value: new Error("read close failed"), mode }, (openedPath, handle) => {
      if (openedPath.endsWith(".tmp")) {
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          injected = true;
          throw primary;
        });
      }
    });
    const read = async () => ({ entry: { migrated: true }, migrated: true });
    const operation = loader === "single"
      ? loadJsonDurableQueueEntry({ paths, tempPrefix: "queue", read })
      : loadPendingJsonDurableQueueEntries({ queueDir: directory, tempPrefix: "queue", read });

    const outcome = await settled(operation);

    expect(injected).toBe(true);
    await expectClosed(records);
    await expect(fs.readFile(paths.processingPath!, "utf8")).resolves.toBe("{}");
    expect(outcome.rejected).toBe(true);
    expect("reason" in outcome && outcome.reason).toBe(primary);
  });

  it("reports a lone close failure after a successful read", async () => {
    const directory = await tempRoot("fs-safe-queue-close-only-");
    const filePath = path.join(directory, "entry.json");
    await fs.writeFile(filePath, "{}");
    const closeFailure = new Error("read close failed");
    const records = observeReadClose(filePath, { value: closeFailure, mode });

    const outcome = await settled(readJsonDurableQueueEntry(filePath));

    await expectClosed(records);
    expect(outcome.rejected).toBe(true);
    expect("reason" in outcome && outcome.reason).toBe(closeFailure);
  });

  it("preserves a falsy callback failure when close succeeds", async () => {
    const directory = await tempRoot("fs-safe-queue-primary-only-");
    const paths = resolveJsonDurableQueueEntryPaths(directory, "job");
    await fs.writeFile(paths.processingPath!, "{}");
    const records = observeReadClose(paths.processingPath!);

    const outcome = await settled(loadJsonDurableQueueEntry({
      paths, tempPrefix: "queue", read: async () => { throw undefined; },
    }));

    await expectClosed(records);
    expect(outcome.rejected).toBe(true);
    expect("reason" in outcome && outcome.reason).toBeUndefined();
  });

  it.each(falsyFailures)("reports a lone falsy close failure (%s) after a successful read", async value => {
    const directory = await tempRoot("fs-safe-queue-close-falsy-");
    const filePath = path.join(directory, "entry.json");
    await fs.writeFile(filePath, "{}");
    const records = observeReadClose(filePath, { value, mode });

    const outcome = await settled(readJsonDurableQueueEntry(filePath));

    await expectClosed(records);
    expect(outcome.rejected).toBe(true);
    expect("reason" in outcome && outcome.reason).toBe(value);
  });
});
