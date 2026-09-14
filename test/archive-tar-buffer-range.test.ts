import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { readArchiveEntry } from "../src/archive-read.js";
import * as tarStream from "../src/archive-tar-stream.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { tarFixture } from "./helpers/archive-fuzz.js";
import { paxHeader } from "./helpers/archive-pax.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); });

it.each([false, true])("returns independent PAX payload bytes from the fully admitted snapshot (gzip=%s)", async gzip => {
  configureFsSafeNative({ mode: "off" });
  const dir = await tempRoot("fs-safe-tar-range-");
  // Explicit kind and magic must determine decompression, not the filename.
  const archivePath = path.join(dir, gzip ? "input.tar" : "input.tgz");
  const payload = Buffer.alloc(8193, 42);
  const raw = tarFixture([
    { path: "unselected", body: Buffer.alloc(65537, 99) },
    paxHeader([["path", "./pkg//value"], ["size", String(payload.length)]]),
    { path: "raw", body: payload, mutateHeader(header) { header.write("00000000001\0", 124); } },
    { path: "after", body: "not requested" },
  ]);
  const bytes = gzip ? gzipSync(raw) : raw;
  await fs.writeFile(archivePath, bytes);
  const inspect = tarStream.inspectTar;
  let admitted: Buffer | undefined;
  vi.spyOn(tarStream, "inspectTar").mockImplementation(async options => {
    await inspect(options);
    admitted = options.archiveBuffer;
    // Admission owns its input: replacing the source cannot change a selected range.
    await fs.writeFile(archivePath, "replaced after admission");
  });
  const result = await readArchiveEntry(archivePath, "pkg/value", { maxBytes: payload.length, kind: "tar" });
  expect(result.equals(payload)).toBe(true);
  expect(result.buffer).not.toBe(admitted!.buffer);
  result.fill(0);
  expect(admitted!.equals(bytes)).toBe(true);
  expect(await fs.readFile(archivePath, "utf8")).toBe("replaced after admission");
});
