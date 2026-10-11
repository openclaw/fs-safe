import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePinnedInput } from "../src/pinned-write-input.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());
async function* chunks(...values: unknown[]) { yield* values as Uint8Array[]; }

async function file() {
  const directory = await tempRoot("fs-safe-pinned-views-");
  const target = path.join(directory, "file");
  return { target, handle: await fs.open(target, "wx+") };
}

describe("small owned-descriptor buffers", () => {
  it("handles positive short writes and advances the existing cursor", async () => {
    const { target, handle } = await file();
    await handle.writeFile("prefix");
    const write = fsSync.writeSync.bind(fsSync);
    const short = vi.spyOn(fsSync, "writeSync").mockImplementation(((fd, data, offset, length, position) =>
      write(fd, data, offset, Math.min(length, 3), position)) as typeof fsSync.writeSync);
    try { await writePinnedInput(handle.fd, { kind: "buffer", data: "payload" }); }
    finally { await handle.close(); }
    expect(short).toHaveBeenCalledTimes(3);
    expect(await fs.readFile(target, "utf8")).toBe("prefixpayload");
  });

  it("rejects an oversized buffer before writing and retains caller ownership", async () => {
    const { target, handle } = await file();
    const write = vi.spyOn(fsSync, "writeSync");
    try {
      await expect(writePinnedInput(handle.fd, { kind: "buffer", data: "payload" }, 2)).rejects.toMatchObject({ code: "too-large" });
      expect(write).not.toHaveBeenCalled();
      expect((await handle.stat()).size).toBe(0);
    } finally { await handle.close(); }
    expect(await fs.readFile(target, "utf8")).toBe("");
  });

  it("rejects zero progress without closing the caller's descriptor", async () => {
    const { handle } = await file();
    vi.spyOn(fsSync, "writeSync").mockReturnValue(0);
    try {
      await expect(writePinnedInput(handle.fd, { kind: "buffer", data: "payload" })).rejects.toMatchObject({ code: "helper-failed" });
      expect((await handle.stat()).isFile()).toBe(true);
    } finally { await handle.close(); }
  });

  it("keeps authority callbacks on the existing asynchronous write path", async () => {
    const { target, handle } = await file();
    const write = vi.spyOn(fsSync, "writeSync");
    const before = vi.fn();
    try { await writePinnedInput(handle.fd, { kind: "buffer", data: "payload" }, undefined, before); }
    finally { await handle.close(); }
    expect(before).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(await fs.readFile(target, "utf8")).toBe("payload");
  });

  it.each([64 * 1024, 64 * 1024 + 1])("bounds synchronous writes for %s-byte buffers", async size => {
    const { target, handle } = await file();
    const write = vi.spyOn(fsSync, "writeSync");
    const content = Buffer.alloc(size, 0x5a);
    try { await writePinnedInput(handle.fd, { kind: "buffer", data: content }); }
    finally { await handle.close(); }
    expect(write.mock.calls.length).toBe(size === 64 * 1024 ? 1 : 0);
    expect(await fs.readFile(target)).toEqual(content);
  });
});

describe("streamed byte-view ownership", () => {
  it("borrows only the sliced backing bytes through positive short writes", async () => {
    const { target, handle } = await file();
    const backing = new Uint8Array(1024 * 1024 + 23).fill(0xab);
    const chunk = new Uint8Array(backing.buffer, 7, 1024 * 1024);
    chunk.fill(0x4a);
    const write = handle.write.bind(handle);
    let calls = 0;
    vi.spyOn(handle, "write").mockImplementation(async (value, offset, length, position) => {
      const bytes = value as Uint8Array;
      expect(bytes !== chunk).toBe(true);
      expect(bytes.buffer === backing.buffer).toBe(true);
      expect(bytes.byteOffset).toBe(7);
      expect(bytes.byteLength).toBe(chunk.byteLength);
      calls++;
      return await write(bytes, offset as number, Math.min(length as number, 65537), position as number | null);
    });
    try { await writePinnedInput(handle, { kind: "stream", stream: chunks(chunk) }, chunk.byteLength); }
    finally { await handle.close(); }
    expect(calls).toBeGreaterThan(2);
    expect((await fs.readFile(target)).equals(Buffer.from(chunk))).toBe(true);
    expect(backing[0]).toBe(0xab);
    expect(backing.at(-1)).toBe(0xab);
  });

  it.each([2, 3])("uses intrinsic metadata for a hostile view at cap %s", async maxBytes => {
    const { target, handle } = await file();
    const chunk = new Uint8Array([1, 2, 3]);
    const hostile = vi.fn(() => { throw new Error("shadowed metadata"); });
    Object.defineProperties(chunk, {
      byteLength: { value: NaN }, length: { get: hostile }, buffer: { get: hostile },
      byteOffset: { get: hostile }, subarray: { get: hostile },
    });
    try {
      const pending = writePinnedInput(handle, { kind: "stream", stream: chunks(chunk) }, maxBytes);
      if (maxBytes === 2) await expect(pending).rejects.toMatchObject({ code: "too-large" });
      else await pending;
    } finally { await handle.close(); }
    expect(hostile).not.toHaveBeenCalled();
    expect(await fs.readFile(target)).toEqual(Buffer.from(maxBytes === 2 ? [] : [1, 2, 3]));
  });

  it.each(["empty", "detached", "out-of-bounds"])("accepts a %s view without reading shadowed metadata", async kind => {
    const { target, handle } = await file();
    const backing = new ArrayBuffer(8, { maxByteLength: 16 });
    const chunk = new Uint8Array(backing, 4, kind === "empty" ? 0 : 4);
    if (kind === "detached") structuredClone(backing, { transfer: [backing] });
    if (kind === "out-of-bounds") backing.resize(0);
    const hostile = vi.fn(() => { throw new Error("shadowed empty metadata"); });
    for (const key of ["length", "buffer", "byteOffset", "byteLength"]) Object.defineProperty(chunk, key, { get: hostile });
    try { await writePinnedInput(handle, { kind: "stream", stream: chunks(chunk) }, 0); }
    finally { await handle.close(); }
    expect(hostile).not.toHaveBeenCalled();
    expect((await fs.stat(target)).size).toBe(0);
  });

  it.each(["buffer", "view"])("finishes each %s generation before pulling again", async kind => {
    const { target, handle } = await file();
    const chunk = kind === "buffer" ? Buffer.from("first") : new Uint8Array(Buffer.from("first"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const write = handle.write.bind(handle);
    let nextPull = false, calls = 0;
    vi.spyOn(handle, "write").mockImplementation(async (...args) => {
      expect((args[0] as Uint8Array).buffer === chunk.buffer).toBe(true);
      expect(args[0] === chunk).toBe(kind === "buffer");
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return await write(...args);
    });
    async function* input() { yield chunk; nextPull = true; chunk.set(Buffer.from("later")); yield chunk; }
    const pending = writePinnedInput(handle, { kind: "stream", stream: input() }, 10);
    try {
      await entered.promise;
      expect(nextPull).toBe(false);
      release.resolve();
      await pending;
    } finally { release.resolve(); await handle.close(); }
    expect(await fs.readFile(target, "utf8")).toBe("firstlater");
  });

  it.each(["text", [1, 256, 3], new Uint16Array([0x102, 0x304]), new DataView(new ArrayBuffer(4))])(
    "retains legacy conversion of %s for internal stream callers", async value => {
      const { target, handle } = await file();
      const expected = Buffer.from(value as Uint8Array);
      try { await writePinnedInput(handle, { kind: "stream", stream: chunks(value) }); }
      finally { await handle.close(); }
      expect(await fs.readFile(target)).toEqual(expected);
    },
  );
});
