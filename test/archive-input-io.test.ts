import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stageArchiveFileForExtraction } from "../src/archive-input.js";
import { resolveExtractLimits } from "../src/archive-limits.js";
import { withExtractionDeadline, type ExtractionDeadline } from "../src/archive-deadline.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

async function fixture(bytes: Buffer) {
  const root = await tempRoot("fs-safe-stage-io-");
  const archivePath = path.join(root, "input");
  await fs.writeFile(archivePath, bytes);
  return archivePath;
}
function stage(archivePath: string, maxArchiveBytes?: number) {
  return withExtractionDeadline(0, "stage", deadline => stageArchiveFileForExtraction({
    archivePath, limits: resolveExtractLimits({ maxArchiveBytes }), deadline,
  }));
}

it("stages large inputs through a single bounded buffer and fewer I/O calls", async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 31, 7);
  bytes[1024 * 1024] = 11;
  bytes[bytes.length - 1] = 13;
  const file = await fixture(bytes);
  const opened: { source?: FileHandle; output?: FileHandle } = {};
  const readBuffers: Buffer[] = [];
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === file) {
      opened.source = handle;
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (buffer, offset, length, position) => {
        readBuffers.push(buffer as Buffer);
        return await read(buffer, offset, length, position);
      });
    } else opened.output = handle;
    return handle;
  });
  const staged = await stage(file);
  try {
    expect((await fs.readFile(staged.path)).equals(bytes)).toBe(true);
    expect(readBuffers.length).toBeLessThan(10);
    expect(readBuffers[0]!.byteLength).toBeLessThanOrEqual(512 * 1024);
    for (const buffer of readBuffers) expect(buffer).toBe(readBuffers[0]);
    expect(opened.source!.fd).toBe(-1);
    expect(opened.output!.fd).toBe(-1);
  } finally { await staged.cleanup(); }
});

it.each([0, 3, 65_536])("clamps scratch allocation and reads to the %i-byte limit plus a probe", async (limit) => {
  const bytes = Buffer.alloc(limit, 7);
  const file = await fixture(bytes);
  const open = fs.open.bind(fs);
  let consumed = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === file) {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (buffer, offset, length, position) => {
        expect(buffer.byteLength).toBeLessThanOrEqual(limit + 1);
        expect(length).toBeLessThanOrEqual(limit - consumed + 1);
        const result = await read(buffer, offset, length, position);
        consumed += result.bytesRead;
        return result;
      });
    }
    return handle;
  });
  const staged = await stage(file, limit);
  try { expect((await fs.readFile(staged.path)).equals(bytes)).toBe(true); }
  finally { await staged.cleanup(); }
});

it("completes short reads and writes before reusing the staging buffer", async () => {
  const bytes = Buffer.from("positive short I/O must preserve every byte");
  const file = await fixture(bytes);
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === file) {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (buffer, offset, length, position) =>
        await read(buffer, offset, Math.min(length, 7), position));
    } else {
      const write = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation(async (buffer, offset, length) =>
        await write(buffer, offset, Math.min(length, 3)));
    }
    return handle;
  });
  const staged = await stage(file);
  try { expect((await fs.readFile(staged.path)).equals(bytes)).toBe(true); }
  finally { await staged.cleanup(); }
});

it("rejects growth using at most one excess byte and removes the partial stage", async () => {
  const file = await fixture(Buffer.from("abc"));
  const open = fs.open.bind(fs);
  let outputPath: string | undefined;
  let source: FileHandle | undefined;
  let output: FileHandle | undefined;
  let consumed = 0;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === file) {
      source = handle;
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (buffer, offset, length, position) => {
        fsSync.appendFileSync(file, "growth");
        const result = await read(buffer, offset, length, position);
        consumed += result.bytesRead;
        return result;
      });
    } else { output = handle; outputPath = String(args[0]); }
    return handle;
  });
  await expect(stage(file, 3)).rejects.toMatchObject({ code: "archive-size-exceeds-limit" });
  expect(consumed).toBe(4);
  expect(source!.fd).toBe(-1);
  expect(output!.fd).toBe(-1);
  await expect(fs.stat(outputPath!)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects cancellation during an EOF read and cleans up both handles and the stage", async () => {
  const file = await fixture(Buffer.alloc(0));
  const controller = new AbortController();
  const reason = new Error("stop staging at EOF");
  const deadline: ExtractionDeadline = {
    signal: controller.signal, check: () => controller.signal.throwIfAborted(), dispose: () => {},
    ownDestinationMutation: async run => await run(), waitForDestinationMutations: async () => {},
  };
  const open = fs.open.bind(fs);
  let outputPath: string | undefined;
  const handles: FileHandle[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    handles.push(handle);
    if (String(args[0]) === file) {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...args) => {
        const result = await read(...args);
        controller.abort(reason);
        return result;
      });
    } else outputPath = String(args[0]);
    return handle;
  });
  await expect(stageArchiveFileForExtraction({ archivePath: file, limits: resolveExtractLimits(), deadline })).rejects.toBe(reason);
  expect(handles.every(handle => handle.fd === -1)).toBe(true);
  await expect(fs.stat(outputPath!)).rejects.toMatchObject({ code: "ENOENT" });
});
