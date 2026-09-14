import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractArchive, inspectTarArchive } from "../src/archive.js";
import { inspectTar } from "../src/archive-tar-stream.js";
import { TarParserStream } from "../src/archive-tar-wasm.js";
import { resolveTarMeterLimits } from "../src/archive-limits.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

async function fixture(bytes: Buffer) {
  const dir = await tempRoot("fs-safe-gzip-output-");
  const archivePath = path.join(dir, "input.tgz"), destDir = path.join(dir, "out");
  await fs.writeFile(archivePath, bytes);
  await fs.mkdir(destDir);
  return { archivePath, destDir, timeoutMs: 10_000 };
}

it("recognizes gzip when the two-byte header arrives in short reads", async () => {
  const input = await fixture(gzipSync(tarFixture([{ path: "value", body: "payload" }])));
  const open = fs.open.bind(fs);
  const requested: number[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === input.archivePath) {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (buffer, offset, length, position) => {
        requested.push(length);
        return await read(buffer, offset, Math.min(length, 1), position);
      });
    }
    return handle;
  });
  const members: string[] = [];
  await inspectTar({ archivePath: input.archivePath, limits: resolveTarMeterLimits(),
    onMember: entry => { members.push(entry.path); },
  });
  expect(members).toEqual(["value"]);
  expect(requested).toEqual([2, 1]);
});

it("feeds file-backed gzip output to the parser in bounded 64 KiB windows", async () => {
  const payload = Buffer.alloc(1024 * 1024, 7);
  const raw = tarFixture([{ path: "value", body: payload }]);
  const input = await fixture(gzipSync(raw));
  const transform = vi.spyOn(TarParserStream.prototype, "_transform");
  expect(await inspectTarArchive(input)).toEqual([{ path: "value", kind: "file", size: payload.length }]);
  const lengths = transform.mock.calls.map(([chunk]) => chunk.length);
  expect(lengths.length).toBeLessThan(24);
  expect(Math.max(...lengths)).toBeLessThanOrEqual(65536);
  expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(raw.length);
});

it.each([65535, 65536, 65537])("preserves payloads across concatenated gzip members split at decoded offset %i", async (split) => {
  const payload = Buffer.alloc(128 * 1024 + 31, 7);
  payload[65535] = 11; payload[65536] = 13; payload[payload.length - 1] = 17;
  const raw = tarFixture([{ path: "value", body: payload }, { path: "sentinel", body: "end" }]);
  const input = await fixture(Buffer.concat([
    gzipSync(raw.subarray(0, split)), gzipSync(raw.subarray(split)), Buffer.alloc(513),
  ]));
  await extractArchive(input);
  expect((await fs.readFile(path.join(input.destDir, "value"))).equals(payload)).toBe(true);
  expect(await fs.readFile(path.join(input.destDir, "sentinel"), "utf8")).toBe("end");
});

it("rejects a corrupt trailer after many decoded windows before filtering or publication", async () => {
  const bytes = gzipSync(tarFixture([{ path: "value", body: Buffer.alloc(1024 * 1024, 7) }]));
  bytes[bytes.length - 8]! ^= 1;
  const input = await fixture(bytes);
  const entryFilter = vi.fn(() => "skip" as const);
  await expect(extractArchive({ ...input, entryFilter, onFiltered: "skip-entry" })).rejects.toThrow();
  expect(entryFilter).not.toHaveBeenCalled();
  expect(await fs.readdir(input.destDir)).toEqual([]);
});

it("enforces the decoded ceiling before filtering when one output window exceeds it", async () => {
  const input = await fixture(gzipSync(tarFixture([{ path: "value", body: Buffer.alloc(1024 * 1024, 7) }])));
  const entryFilter = vi.fn(() => "skip" as const);
  await expect(extractArchive({ ...input, entryFilter, onFiltered: "skip-entry",
    limits: { maxArchiveBytes: 4096, maxExtractedBytes: 0 },
  })).rejects.toMatchObject({ code: "archive-decoded-size-exceeds-limit" });
  expect(entryFilter).not.toHaveBeenCalled();
  expect(await fs.readdir(input.destDir)).toEqual([]);
});

it("joins the file and parser streams after cancellation during decoded output", async () => {
  const input = await fixture(gzipSync(tarFixture([{ path: "value", body: Buffer.alloc(1024 * 1024, 7) }])));
  const controller = new AbortController();
  const source = vi.spyOn(fsSync, "createReadStream");
  const transform = TarParserStream.prototype._transform;
  let parser: TarParserStream | undefined;
  const reads = vi.spyOn(TarParserStream.prototype, "_transform").mockImplementation(function (this: TarParserStream, chunk, encoding, callback) {
    parser = this;
    transform.call(this, chunk, encoding, callback);
    controller.abort(new Error("cancel decoded output"));
  });
  await expect(inspectTar({ archivePath: input.archivePath, limits: resolveTarMeterLimits(), signal: controller.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(reads.mock.calls.length).toBeLessThan(17);
  expect(parser!.destroyed).toBe(true);
  expect(source.mock.results[0]!.value.closed).toBe(true);
});
