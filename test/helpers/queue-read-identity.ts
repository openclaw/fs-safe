import { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";

export const queueIdentity = { dev: 7n, ino: 9007199254806528n };
export const queuePayload = '{"entry":"original"}';
export type QueueBoundary = "preview" | "descriptor" | "current";
type Sample = Partial<typeof queueIdentity> & {
  kind?: "symlink" | "not-file";
  nlink?: bigint;
  size?: bigint;
};
export type QueueSamples = Partial<Record<QueueBoundary, (Sample | Error)[]>>;

// Real local I/O with modeled Windows stat receipts, including the numeric
// projection returned when a caller omits bigint. This is not kernel proof.
export async function observeQueueRead(directory: string, samples: QueueSamples = {}) {
  const filePath = path.join(directory, "entry.json");
  await fs.writeFile(filePath, queuePayload);
  const events: string[] = [];
  const counts = { preview: 0, descriptor: 0, current: 0 };
  const observations: { boundary: QueueBoundary; bigint: boolean }[] = [];
  const handles: fs.FileHandle[] = [];
  const read = vi.fn();
  const close = vi.fn();

  function observe(boundary: QueueBoundary, stat: Stats | BigIntStats, bigint: boolean) {
    events.push(boundary);
    observations.push({ boundary, bigint });
    const sequence = samples[boundary];
    const attempt = counts[boundary]++;
    const sample = sequence?.[Math.min(attempt, sequence.length - 1)] ?? {};
    if (sample instanceof Error) throw sample;
    const identity = { ...queueIdentity, ...sample };
    stat.dev = bigint ? identity.dev : Number(identity.dev);
    stat.ino = bigint ? identity.ino : Number(identity.ino);
    if (sample.nlink !== undefined) stat.nlink = bigint ? sample.nlink : Number(sample.nlink);
    if (sample.size !== undefined) stat.size = bigint ? sample.size : Number(sample.size);
    if (sample.kind) {
      stat.isSymbolicLink = () => sample.kind === "symlink";
      stat.isFile = () => false;
    }
    return stat;
  }

  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const stat = await lstat(...args);
    if (args[0] !== filePath) return stat;
    return observe(handles.length === 0 ? "preview" : "current", stat, args[1]?.bigint === true);
  });
  const actualOpen = fs.open.bind(fs);
  const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await actualOpen(...args);
    if (args[0] !== filePath) return handle;
    events.push("open");
    handles.push(handle);
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async (options) =>
      observe("descriptor", await stat(options), options?.bigint === true),
    );
    const actualRead = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async (...args) => {
      events.push("read");
      read(handle.fd);
      return await actualRead(...args);
    });
    const actualClose = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      events.push("close");
      close(handle.fd);
      await actualClose();
    });
    return handle;
  });
  return { filePath, events, counts, observations, handles, open, read, close };
}
