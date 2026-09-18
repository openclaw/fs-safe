import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchive, readArchiveEntry } from "../src/archive.js";
import { inspectTar, replayTar } from "../src/archive-tar-stream.js";
import { TarParserStream, TarWasmSession, type AdmittedTarMember } from "../src/archive-tar-wasm.js";
import { resolveTarMeterLimits } from "../src/archive-limits.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { archiveCodecFixtures, codecLargeTar } from "./helpers/archive-codec-fixtures.js";
import { compressedTarFraming } from "./helpers/archive-tar-framing-compressed.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });
const limits = resolveTarMeterLimits();

// Standard single-segment Zstandard framing with raw blocks; no external codec.
function rawZstd(bytes: Buffer): Buffer {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(0xfd2fb528); header[4] = 0xa0; header.writeUInt32LE(bytes.length, 5);
  const blocks = [header];
  for (let offset = 0; offset < bytes.length || offset === 0; offset += 65536) {
    const body = bytes.subarray(offset, offset + 65536), block = Buffer.alloc(3);
    block.writeUIntLE((body.length << 3) | Number(offset + body.length === bytes.length), 0, 3);
    blocks.push(block, body);
  }
  return Buffer.concat(blocks);
}
function skippable(bytes: number): Buffer {
  const frame = Buffer.alloc(8 + bytes);
  frame.writeUInt32LE(0x184d2a50); frame.writeUInt32LE(bytes, 4);
  return frame;
}
async function fileInput(archiveBuffer: Buffer) {
  const root = await tempRoot("fs-safe-codec-transport-");
  const archivePath = path.join(root, "input.bin"), destDir = path.join(root, "out");
  await fs.writeFile(archivePath, archiveBuffer); await fs.mkdir(destDir);
  return { archivePath, destDir, timeoutMs: 10_000 };
}

it.each([1, 7, 65535, 65536, 65537])("retains decoded bytes when compressed chunks have %i bytes", async chunkSize => {
  const payload = Buffer.alloc((chunkSize < 8 ? 2048 : 128 * 1024) + 19);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + (i >>> 8)) & 255;
  const raw = tarFixture([{ path: "value", body: payload }]);
  const archiveBuffer = rawZstd(raw);
  function* chunks() { for (let i = 0; i < archiveBuffer.length; i += chunkSize) yield archiveBuffer.subarray(i, i + chunkSize); }
  const session = new TarWasmSession(limits), admitted: AdmittedTarMember[] = [], retained: Buffer[] = [];
  try {
    await pipeline(Readable.from(chunks(), { objectMode: false }), source => session.decode(source, "tar-zstd"),
      new TarParserStream(limits, member => admitted.push(member), session),
      new Writable({ write(chunk: Buffer, _encoding, callback) { retained.push(chunk); callback(); } }));
    expect(admitted.map(entry => entry.path)).toEqual(["value"]);
    expect(retained.reduce((maximum, chunk) => Math.max(maximum, chunk.length), 0)).toBeLessThanOrEqual(65536);
    expect(Buffer.concat(retained).equals(raw)).toBe(true);
  } finally { session.dispose(); }
});

for (const kind of ["tar-zstd", "tar-bzip2"] as const) {
  const good = Buffer.from(compressedTarFraming[0][kind], "base64");
  describe(`${kind} complete stream and teardown`, () => {
    it.each(["junk", "partial-next-member"])("rejects %s after selected bytes and TAR EOF", async tail => {
      const archiveBuffer = Buffer.concat([good, tail === "junk" ? Buffer.from("invalid trailer") : good.subarray(0, 9)]);
      const input = await fileInput(archiveBuffer), entryFilter = vi.fn(() => "extract" as const);
      await expect(extractArchive({ ...input, kind, entryFilter })).rejects.toMatchObject({ name: "ArchiveFormatError" });
      expect(entryFilter).not.toHaveBeenCalled();
      expect(await fs.readdir(input.destDir)).toEqual([]);
      await expect(readArchiveEntry(input.archivePath, "value", { kind, maxBytes: 7 })).rejects.toMatchObject({ name: "ArchiveFormatError" });
    });

    it("joins file, decoder and parser before disposing after a late consumer error", async () => {
      const expanding = archiveCodecFixtures.find(fixture => fixture.kind === kind)!;
      const input = await fileInput(Buffer.from(expanding.large, "base64")), members: AdmittedTarMember[] = [];
      await inspectTar({ ...input, kind, limits, onMember: entry => members.push(entry) });
      const sources = vi.spyOn(fsSync, "createReadStream");
      const decode = TarWasmSession.prototype.decode, dispose = TarWasmSession.prototype.dispose;
      let active = 0;
      const disposalStates: Array<{ active: number; closed: boolean[] }> = [];
      vi.spyOn(TarWasmSession.prototype, "decode").mockImplementation(async function* (this: TarWasmSession, ...args) {
        active++;
        try { yield* decode.apply(this, args); } finally { active--; }
      });
      const disposed = vi.spyOn(TarWasmSession.prototype, "dispose").mockImplementation(function (this: TarWasmSession) {
        disposalStates.push({ active, closed: sources.mock.results.map(result => result.type === "return" && result.value.closed) });
        dispose.call(this);
      });
      const failure = new Error("late output write rejected");
      await expect(replayTar({ ...input, kind, limits, members, async consume(_entry, payload) {
        for await (const _chunk of payload) { await setImmediate(); expect(active).toBe(1); throw failure; }
      } })).rejects.toBe(failure);
      expect(active).toBe(0); expect(disposed).toHaveBeenCalledTimes(1); expect(disposalStates).toEqual([{ active: 0, closed: [true] }]);
    });

    it("disposes an admitted session before a late filter throws without publishing", async () => {
      const input = await fileInput(good), failure = new Error("late filter rejected");
      const dispose = vi.spyOn(TarWasmSession.prototype, "dispose");
      const entryFilter = vi.fn(() => {
        expect(dispose).toHaveBeenCalledTimes(1);
        throw failure;
      });
      await expect(extractArchive({ ...input, kind, entryFilter })).rejects.toBe(failure);
      expect(entryFilter).toHaveBeenCalledTimes(1); expect(await fs.readdir(input.destDir)).toEqual([]);
    });
  });
}

it.each(archiveCodecFixtures)("honors $kind output backpressure without retaining the full decoded archive", async fixture => {
  const archiveBuffer = Buffer.from(fixture.large, "base64"), members: AdmittedTarMember[] = [];
  await inspectTar({ archiveBuffer, kind: fixture.kind, limits, onMember: entry => members.push(entry) });
  const parse = vi.spyOn(TarWasmSession.prototype, "parse");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  let total = 0;
  const replay = replayTar({ archiveBuffer, kind: fixture.kind, limits, members, async consume(_entry, payload) {
    for await (const chunk of payload) {
      if (total === 0) { entered(); await gate; }
      expect(chunk.every(byte => byte === 0)).toBe(true); total += chunk.length;
    }
  } });
  try {
    await ready;
    for (let i = 0; i < 4; i++) await setImmediate();
    expect(parse.mock.calls.length).toBeLessThanOrEqual(8);
  } finally { release(); await replay; }
  expect(total).toBe(8 * 1024 * 1024 + 1);
});

it.each(["skippable", "decoded"])("yields to timer cancellation during large %s input", async mode => {
  const raw = tarFixture([{ path: "value", body: Buffer.alloc(mode === "decoded" ? 16 * 1024 * 1024 : 1) }]);
  const archiveBuffer = mode === "skippable" ? Buffer.concat([skippable(16 * 1024 * 1024), rawZstd(raw)]) : rawZstd(raw);
  const controller = new AbortController(), dispose = vi.spyOn(TarWasmSession.prototype, "dispose");
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; controller.abort(new Error("timer cancellation")); }, 0);
  try {
    await expect(inspectTar({ archiveBuffer, kind: "tar-zstd", limits, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(timerRan).toBe(true); expect(dispose).toHaveBeenCalledTimes(1);
  } finally { clearTimeout(timer); }
});

for (const fixture of archiveCodecFixtures) {
  it.each([1, 7, 65536])(`retains ${fixture.kind} output across %i-byte compressed chunks and repeated decoder drains`, async chunkSize => {
    const bytes = Buffer.from(fixture.large, "base64"), session = new TarWasmSession(limits);
    async function* input() { for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize); }
    try {
      const retained: Buffer[] = [];
      for await (const output of session.decode(input(), fixture.kind)) retained.push(output);
      expect(retained.length).toBeGreaterThan(128);
      expect(retained.every(chunk => chunk.length <= 65536)).toBe(true);
      expect(Buffer.concat(retained).equals(codecLargeTar())).toBe(true);
    } finally { session.dispose(); }
  });

  it.each([1, 511, 512, 513] as const)(`accepts ${fixture.kind} members splitting the TAR at offset %i`, async split => {
    const archiveBuffer = Buffer.concat([Buffer.from(fixture[`prefix${split}`], "base64"),
      Buffer.from(fixture.empty, "base64"), Buffer.from(fixture[`rest${split}`], "base64")]);
    const input = await fileInput(archiveBuffer);
    await expect(readArchiveEntry(input.archivePath, "value.txt", { kind: fixture.kind, maxBytes: 100 }))
      .resolves.toEqual(Buffer.from("actual codec and complete container checks\n"));
  });

  it(`rejects ${fixture.kind} checksum failure before filtering or selected-byte return`, async () => {
    const encoded = Buffer.from(fixture.small, "base64");
    encoded[encoded.length - 2]! ^= 8;
    const input = await fileInput(encoded), entryFilter = vi.fn(() => "extract" as const);
    await expect(extractArchive({ ...input, kind: fixture.kind, entryFilter })).rejects.toMatchObject({ name: "ArchiveFormatError" });
    await expect(readArchiveEntry(input.archivePath, "value.txt", { kind: fixture.kind, maxBytes: 100 })).rejects.toMatchObject({ name: "ArchiveFormatError" });
    expect(entryFilter).not.toHaveBeenCalled(); expect(await fs.readdir(input.destDir)).toEqual([]);
  });

  it(`yields to cancellation across output-free tiny ${fixture.kind} members`, async () => {
    const empty = Buffer.from(fixture.empty, "base64");
    const archiveBuffer = Buffer.concat([...Array.from({ length: 10000 }, () => empty), Buffer.from(fixture.small, "base64")]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("empty-member cancellation")), 0);
    try {
      await expect(inspectTar({ archiveBuffer, kind: fixture.kind, limits, signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
    } finally { clearTimeout(timer); }
  });
}
