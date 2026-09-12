import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { readJsonDurableQueueEntry } from "../src/json-durable-queue.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it("preserves UTF-8 across short reads with an exact byte budget", async () => {
  const dir = await tempRoot("fs-safe-queue-short-read-");
  const filePath = path.join(dir, "entry.json");
  const entry = { text: "€🦞".repeat(200) };
  const bytes = JSON.stringify(entry);
  await fs.writeFile(filePath, bytes);
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === filePath) {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (buffer, offset, length, position) =>
        await read(buffer, offset, Math.min(length, 7), position),
      );
    }
    return handle;
  });
  await expect(readJsonDurableQueueEntry(filePath, { maxBytes: Buffer.byteLength(bytes) }))
    .resolves.toEqual(entry);
});

it("preserves an underlying read error even when it uses the shared limit code", async () => {
  const dir = await tempRoot("fs-safe-queue-read-error-");
  const filePath = path.join(dir, "entry.json");
  await fs.writeFile(filePath, "{}");
  const error = new FsSafeError("too-large", "underlying read failed");
  const open = fs.open.bind(fs);
  let opened: fs.FileHandle | undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === filePath) {
      opened = handle;
      vi.spyOn(handle, "read").mockRejectedValue(error);
    }
    return handle;
  });
  await expect(readJsonDurableQueueEntry(filePath)).rejects.toBe(error);
  expect(opened?.fd).toBe(-1);
});
