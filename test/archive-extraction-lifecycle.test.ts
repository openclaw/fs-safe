import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveFormatError,
  ArchiveLimitError,
  extractArchive,
} from "../src/archive.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { zipRecords, type ZipRecord } from "./helpers/zip-records.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
});

async function fixture(bytes: Buffer) {
  const work = await tempRoot("fs-safe-extraction-lifecycle-");
  const archivePath = path.join(work, "input.zip");
  const destDir = path.join(work, "output");
  await fs.writeFile(archivePath, bytes);
  await fs.mkdir(destDir);
  await fs.writeFile(path.join(destDir, "sentinel"), "unchanged");
  return { archivePath, destDir, kind: "zip" as const };
}

function corruptFirstPayload(records: ZipRecord[], field: "size" | "crc", value: number) {
  const bytes = zipRecords(records);
  const central = bytes.readUInt32LE(bytes.length - 22 + 16);
  // Keep local/central admission consistent so failure occurs while streaming.
  bytes.writeUInt32LE(value, field === "size" ? 22 : 14);
  bytes.writeUInt32LE(value, central + (field === "size" ? 24 : 16));
  return bytes;
}

async function expectUnpublished(destDir: string) {
  expect(await fs.readdir(destDir)).toEqual(["sentinel"]);
  expect(await fs.readFile(path.join(destDir, "sentinel"), "utf8")).toBe("unchanged");
}

describe.each([false, true])("portable ZIP extraction lifecycle (deflate=%s)", (deflate) => {
  it("does not call later filters after a corrupt accepted payload", async () => {
    const input = await fixture(corruptFirstPayload([
      { name: "first", body: "payload", deflate }, { name: "later" },
    ], "crc", 0));
    const observed: string[] = [];
    const operation = extractArchive({ ...input, entryFilter: entry => {
      observed.push(entry.path); return "extract";
    } });
    await expect(operation).rejects.toBeInstanceOf(ArchiveFormatError);
    await expect(operation).rejects.toMatchObject({ code: "archive-header-invalid" });
    expect(observed).toEqual(["first"]);
    await expectUnpublished(input.destDir);
  });

  it("checks integrity rather than charging an oversized declared size", async () => {
    const input = await fixture(corruptFirstPayload([
      { name: "first", body: "x", deflate }, { name: "later" },
    ], "size", 100));
    const observed: { path: string; size: number }[] = [];
    const operation = extractArchive({ ...input,
      limits: { maxEntryBytes: 4, maxExtractedBytes: 4 },
      entryFilter: entry => { observed.push({ path: entry.path, size: entry.size }); return "extract"; },
    });
    await expect(operation).rejects.toBeInstanceOf(ArchiveFormatError);
    await expect(operation).rejects.toMatchObject({ code: "archive-header-invalid" });
    expect(observed).toEqual([{ path: "first", size: 100 }]);
    await expectUnpublished(input.destDir);
  });

  it.each([
    [{ maxEntryBytes: 4 }, ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT],
    [{ maxExtractedBytes: 4 }, ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT],
  ])("charges actual bytes before integrity or later filters with %j", async (limits, code) => {
    const input = await fixture(corruptFirstPayload([
      { name: "first", body: "more than four bytes", deflate }, { name: "later" },
    ], "size", 1));
    const observed: string[] = [];
    const operation = extractArchive({ ...input, limits, entryFilter: entry => {
      observed.push(entry.path); return "extract";
    } });
    await expect(operation).rejects.toBeInstanceOf(ArchiveLimitError);
    await expect(operation).rejects.toMatchObject({ code });
    expect(observed).toEqual(["first"]);
    await expectUnpublished(input.destDir);
  });

  it("retains the actual-byte budget across accepted entries", async () => {
    const input = await fixture(zipRecords([
      { name: "first", body: "abc", deflate },
      { name: "second", body: "def", deflate },
      { name: "later" },
    ]));
    const observed: string[] = [];
    await expect(extractArchive({ ...input,
      limits: { maxEntryBytes: 3, maxExtractedBytes: 5 },
      entryFilter: entry => { observed.push(entry.path); return "extract"; },
    })).rejects.toMatchObject({ code: ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT });
    expect(observed).toEqual(["first", "second"]);
    await expectUnpublished(input.destDir);
  });

  it("charges each accepted payload once and resets the per-entry budget", async () => {
    const input = await fixture(zipRecords([
      { name: "skipped", body: "larger than either budget", deflate },
      { name: "first", body: "abc", deflate },
      { name: "second", body: "def", deflate },
    ]));
    await extractArchive({ ...input,
      limits: { maxEntryBytes: 3, maxExtractedBytes: 6 },
      onFiltered: "skip-entry",
      entryFilter: entry => entry.path === "skipped" ? "skip" : "extract",
    });
    expect((await fs.readdir(input.destDir)).sort()).toEqual(["first", "second", "sentinel"]);
    expect(await fs.readFile(path.join(input.destDir, "first"), "utf8")).toBe("abc");
    expect(await fs.readFile(path.join(input.destDir, "second"), "utf8")).toBe("def");
  });
});

it("finishes staging before the next filter and removes both stages when that filter throws", async () => {
  const zip = new JSZip();
  zip.file("first", "first payload");
  zip.file("second", "second payload");
  const input = await fixture(await zip.generateAsync({ type: "nodebuffer" }));
  const open = fs.open.bind(fs);
  const handles: FileHandle[] = [];
  let inputStage: string | undefined;
  let outputStage: string | undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    handles.push(handle);
    const openedPath = String(args[0]);
    if (openedPath !== input.archivePath && path.basename(openedPath) === "input.zip") {
      inputStage = path.dirname(openedPath);
    }
    if (path.basename(openedPath).startsWith(".fs-safe-stream.")) {
      outputStage = path.dirname(openedPath);
    }
    return handle;
  });
  const failure = new Error("second filter refused");
  const observed: string[] = [];
  await expect(extractArchive({ ...input, entryFilter: entry => {
    observed.push(entry.path);
    if (entry.path === "second") {
      expect(outputStage).toBeDefined();
      expect(fsSync.readFileSync(path.join(outputStage!, "first"), "utf8")).toBe("first payload");
      throw failure;
    }
    return "extract";
  } })).rejects.toBe(failure);
  expect(observed).toEqual(["first", "second"]);
  expect(inputStage).toBeDefined();
  expect(outputStage).toBeDefined();
  for (const stage of [inputStage!, outputStage!]) {
    await expect(fs.stat(stage)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(handles.every(handle => handle.fd === -1)).toBe(true);
  await expectUnpublished(input.destDir);
});
