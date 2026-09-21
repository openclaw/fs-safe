import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sha256File, sha256FileSync } from "../src/file-hash.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

async function fixture(size: number) {
  const directory = await tempRoot("fs-safe-hash-reuse-");
  const file = path.join(directory, "input");
  const contents = Buffer.alloc(size, 0x71);
  contents.set([0x31, 0x32, 0x33]);
  await fs.writeFile(file, contents);
  configureFsSafeNative({ mode: "off" });
  return { file, expected: { bytes: size, digest: createHash("sha256").update(contents).digest("hex") } };
}

function scratch(value: unknown): Buffer {
  if (!Buffer.isBuffer(value)) throw new Error("Expected a hash scratch buffer");
  return value;
}

function blockedHashes(handles: FileHandle[], signals: Array<AbortSignal | undefined> = []) {
  const entered = handles.map(() => Promise.withResolvers<Buffer>());
  const gates = handles.map(() => Promise.withResolvers<void>());
  const reads = handles.map((handle, index) => {
    const read = handle.read.bind(handle);
    return vi.spyOn(handle, "read").mockImplementationOnce(async (...args) => {
      entered[index]!.resolve(scratch(args[0]));
      await gates[index]!.promise;
      return await read(...args);
    });
  });
  const operations = handles.map((handle, index) => sha256File(handle, { signal: signals[index] }));
  const settled = Promise.allSettled(operations);
  return {
    operations,
    gates,
    entered: Promise.race([
      Promise.all(entered.map(({ promise }) => promise)),
      Promise.all(operations).then(() => { throw new Error("Hashes completed before blocked reads"); }),
    ]),
    async finish() {
      for (const gate of gates) gate.resolve();
      await settled;
      for (const read of reads) read.mockRestore();
    },
  };
}

it("reuses scratch across sequential async and sync hashes without retaining content or advancing the cursor", async () => {
  const { file, expected } = await fixture(96 * 1024 + 17);
  const handle = await fs.open(file, "r");
  const read = handle.read.bind(handle);
  await read(Buffer.alloc(2), 0, 2, null);
  const asyncRead = vi.spyOn(handle, "read");
  const syncRead = vi.spyOn(fsSync, "readSync");
  try {
    for (let index = 0; index < 24; index++) {
      const result = index % 2 === 0 ? await sha256File(handle) : sha256FileSync(handle.fd);
      expect(result).toEqual(expected);
    }
    const buffers = [
      ...asyncRead.mock.calls.map((call) => scratch(call[0])),
      ...syncRead.mock.calls.map((call) => scratch(call[1])),
    ];
    expect(new Set(buffers.map((buffer) => buffer.buffer)).size).toBe(1);
    for (const buffer of buffers) {
      expect(buffer.length).toBeLessThanOrEqual(expected.bytes + 1);
      expect(buffer.every((byte) => byte === 0)).toBe(true);
    }
    const next = Buffer.alloc(1);
    await read(next, 0, 1, null);
    expect(next[0]).toBe(0x33);
  } finally {
    await handle.close();
  }
});

it("retains only four scratch allocations after a larger concurrent burst", async () => {
  const { file, expected } = await fixture(256 * 1024 + 3);
  const handles = await Promise.all(Array.from({ length: 9 }, () => fs.open(file, "r")));
  const batch = async () => {
    const pending = blockedHashes(handles);
    try {
      const buffers = await pending.entered;
      const storage = new Set(buffers.map((buffer) => buffer.buffer));
      expect(storage.size).toBe(handles.length);
      for (const buffer of buffers) expect(buffer.length).toBeLessThanOrEqual(256 * 1024);
      for (const gate of pending.gates) gate.resolve();
      expect(await Promise.all(pending.operations)).toEqual(handles.map(() => expected));
      return storage;
    } finally {
      await pending.finish();
    }
  };
  try {
    const first = await batch();
    const second = await batch();
    expect([...second].filter((buffer) => first.has(buffer))).toHaveLength(4);
  } finally {
    await Promise.all(handles.map((handle) => handle.close()));
  }
});

it("keeps aborted reads exclusive until settlement and then reuses their cleared storage", async () => {
  const { file, expected } = await fixture(256 * 1024 + 3);
  const handles = await Promise.all(Array.from({ length: 10 }, () => fs.open(file, "r")));
  const controller = new AbortController();
  const reason = new Error("hash cancelled with a read pending");
  const pending = blockedHashes(handles.slice(0, 9), [controller.signal]);
  let resumed: ReturnType<typeof blockedHashes> | undefined;
  try {
    const buffers = await pending.entered;
    const rejected = expect(pending.operations[0]).rejects.toBe(reason);
    controller.abort(reason);
    const other = handles[9]!;
    const read = vi.spyOn(other, "read");
    expect(await sha256File(other)).toEqual(expected);
    const extraStorage = scratch(read.mock.calls[0]![0]).buffer;
    expect(buffers.some((buffer) => buffer.buffer === extraStorage)).toBe(false);
    read.mockRestore();
    pending.gates[0]!.resolve();
    await rejected;
    expect(buffers[0]!.every((byte) => byte === 0)).toBe(true);

    resumed = blockedHashes([handles[0]!, other]);
    const reusable = new Set((await resumed.entered).map((buffer) => buffer.buffer));
    expect(reusable.has(buffers[0]!.buffer)).toBe(true);
    expect(reusable.has(extraStorage)).toBe(true);
    for (const buffer of buffers.slice(1)) expect(reusable.has(buffer.buffer)).toBe(false);
    for (const gate of resumed.gates) gate.resolve();
    expect(await Promise.all(resumed.operations)).toEqual([expected, expected]);
  } finally {
    await resumed?.finish();
    await pending.finish();
    await Promise.all(handles.map((handle) => handle.close()));
  }
});
