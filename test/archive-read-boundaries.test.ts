import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "./helpers/vitest.js";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveFormatError,
  ArchiveLimitError,
  readArchiveEntry,
} from "../src/archive.js";
import { preflightTarMetadata } from "../src/archive-tar-meta.js";
import {
  __resetFsSafeNativeConfigForTest,
  configureFsSafeNative,
} from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";

const { tempRoot } = useTempDirs();

type TarEntry = {
  path: string;
  body?: Buffer | string;
  type?: string;
  mutateHeader?: (header: Buffer) => void;
};

function writeString(block: Buffer, offset: number, length: number, value: string): void {
  block.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  writeString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function tarFixture(entries: TarEntry[], endBlocks = true): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, entry.type ?? "0");
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    entry.mutateHeader?.(header);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  if (endBlocks) blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function rawHeader(type = "0", size = 0): Buffer {
  return tarFixture([{ path: "entry", type, body: Buffer.alloc(size) }], false).subarray(0, 512);
}

beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

describe("TAR metadata preflight boundaries", () => {
  it("accepts metadata at the byte limit and rejects one byte past it", async () => {
    const root = await tempRoot("fs-safe-tar-meta-limit-");
    const atLimit = path.join(root, "at-limit.tar");
    const pastLimit = path.join(root, "past-limit.tar");
    await fs.writeFile(atLimit, tarFixture([{ path: "long-name", type: "L", body: "x".repeat(16) }]));
    await fs.writeFile(pastLimit, tarFixture([{ path: "long-name", type: "L", body: "x".repeat(17) }]));

    await expect(preflightTarMetadata({ archivePath: atLimit, maxMetaEntryBytes: 16 }))
      .resolves.toBeUndefined();
    await expect(preflightTarMetadata({ archivePath: pastLimit, maxMetaEntryBytes: 16 }))
      .rejects.toMatchObject({
        code: ARCHIVE_LIMIT_ERROR_CODE.META_ENTRY_SIZE_EXCEEDS_LIMIT,
      });
  });

  it("rejects truncated headers and entry bodies distinctly", async () => {
    const root = await tempRoot("fs-safe-tar-truncated-");
    const headerPath = path.join(root, "header.tar");
    const entryPath = path.join(root, "entry.tar");
    await fs.writeFile(headerPath, Buffer.alloc(511));
    await fs.writeFile(entryPath, tarFixture([{ path: "value", body: "payload" }], false).subarray(0, 513));

    await expect(preflightTarMetadata({ archivePath: headerPath, maxMetaEntryBytes: 1024 }))
      .rejects.toThrow("truncated TAR header");
    await expect(preflightTarMetadata({ archivePath: entryPath, maxMetaEntryBytes: 1024 }))
      .rejects.toThrow("truncated TAR entry");
  });

  it("rejects malformed octal and unsafe base-256 sizes", async () => {
    const root = await tempRoot("fs-safe-tar-size-");
    const malformedPath = path.join(root, "malformed.tar");
    const highBitsPath = path.join(root, "high-bits.tar");
    const paddingPath = path.join(root, "padding.tar");
    const malformed = rawHeader();
    malformed.fill(0x20, 124, 136);
    malformed.write("00000000008\0", 124, "ascii");
    const highBits = rawHeader();
    highBits.fill(0, 124, 136);
    highBits[124] = 0x80;
    highBits[125] = 1;
    const padding = rawHeader();
    padding.fill(0, 124, 136);
    padding[124] = 0x80;
    padding.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER), 128);
    const negative = rawHeader();
    negative.fill(0xff, 124, 136);
    await fs.writeFile(malformedPath, malformed);
    await fs.writeFile(highBitsPath, highBits);
    await fs.writeFile(paddingPath, padding);

    await expect(preflightTarMetadata({ archivePath: malformedPath, maxMetaEntryBytes: 1024 }))
      .rejects.toThrow("size is not valid octal");
    await expect(preflightTarMetadata({ archivePath: highBitsPath, maxMetaEntryBytes: 1024 }))
      .rejects.toThrow("base-256 size exceeds the safe integer range");
    await expect(preflightTarMetadata({ archivePath: paddingPath, maxMetaEntryBytes: 1024 }))
      .rejects.toThrow("entry padding exceeds the safe integer range");
    await fs.writeFile(paddingPath, negative);
    await expect(preflightTarMetadata({ archivePath: paddingPath, maxMetaEntryBytes: 1024 }))
      .rejects.toThrow("base-256 size is negative or malformed");
  });

  it("rejects PAX and malformed GNU sparse metadata before a parser can buffer it", async () => {
    const root = await tempRoot("fs-safe-tar-meta-malformed-");
    const paxPath = path.join(root, "pax.tar");
    const sparseFlagPath = path.join(root, "sparse-flag.tar");
    const sparseExtensionPath = path.join(root, "sparse-extension.tar");
    const sparseLimitPath = path.join(root, "sparse-limit.tar");
    const sparseUnsupportedPath = path.join(root, "sparse-unsupported.tar");
    await fs.writeFile(paxPath, tarFixture([{ path: "pax", type: "x", body: "9 path=a\n" }]));
    const sparseFlag = rawHeader("S");
    sparseFlag[482] = 2;
    await fs.writeFile(sparseFlagPath, sparseFlag);
    const sparseExtension = rawHeader("S");
    sparseExtension[482] = 1;
    const invalidExtension = Buffer.alloc(512);
    invalidExtension[504] = 2;
    await fs.writeFile(sparseExtensionPath, Buffer.concat([sparseExtension, invalidExtension]));
    const repeatedExtension = Buffer.alloc(512);
    repeatedExtension[504] = 1;
    await fs.writeFile(sparseLimitPath, Buffer.concat([sparseExtension, repeatedExtension]));
    const finalExtension = Buffer.alloc(512);
    await fs.writeFile(
      sparseUnsupportedPath,
      Buffer.concat([sparseExtension, repeatedExtension, finalExtension]),
    );

    await expect(preflightTarMetadata({ archivePath: paxPath, maxMetaEntryBytes: 1024 }))
      .rejects.toThrow("PAX metadata is unmeterable");
    await expect(preflightTarMetadata({ archivePath: sparseFlagPath, maxMetaEntryBytes: 1024 }))
      .rejects.toThrow("GNU sparse extension flag is not 0 or 1");
    await expect(preflightTarMetadata({ archivePath: sparseExtensionPath, maxMetaEntryBytes: 1024 }))
      .rejects.toThrow("GNU sparse extension flag is not 0 or 1");
    await expect(preflightTarMetadata({ archivePath: sparseLimitPath, maxMetaEntryBytes: 511 }))
      .rejects.toMatchObject({
        code: ARCHIVE_LIMIT_ERROR_CODE.META_ENTRY_SIZE_EXCEEDS_LIMIT,
      });
    await expect(preflightTarMetadata({ archivePath: sparseUnsupportedPath, maxMetaEntryBytes: 1024 }))
      .rejects.toThrow("GNU sparse entries are not supported");
  });

  it("accepts an octal size field that occupies all twelve bytes", async () => {
    const root = await tempRoot("fs-safe-tar-full-octal-");
    const archivePath = path.join(root, "full-octal.tar");
    const header = rawHeader();
    header.write("000000000001", 124, "ascii");
    await fs.writeFile(archivePath, Buffer.concat([header, Buffer.alloc(512)]));

    await expect(preflightTarMetadata({ archivePath, maxMetaEntryBytes: 1024 }))
      .resolves.toBeUndefined();
  });

  it("meters gzip-compressed TAR input and honors an already-aborted signal", async () => {
    const root = await tempRoot("fs-safe-tar-gzip-");
    const archivePath = path.join(root, "fixture.tar.gz");
    await fs.writeFile(archivePath, gzipSync(tarFixture([{ path: "value", body: "ok" }])));
    await expect(preflightTarMetadata({ archivePath, maxMetaEntryBytes: 1024 }))
      .resolves.toBeUndefined();
    const controller = new AbortController();
    controller.abort(new Error("deadline elapsed"));
    await expect(preflightTarMetadata({
      archivePath,
      maxMetaEntryBytes: 1024,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "ABORT_ERR" });
  });
});

describe("bounded archive reads", () => {
  it("rejects invalid requests before opening an archive", async () => {
    await expect(readArchiveEntry("missing.zip", "value", { maxBytes: -1 }))
      .rejects.toBeInstanceOf(RangeError);
    await expect(readArchiveEntry("missing.zip", "value", { maxBytes: Number.MAX_SAFE_INTEGER + 1 }))
      .rejects.toBeInstanceOf(RangeError);
    await expect(readArchiveEntry("missing.unknown", "value", { maxBytes: 1 }))
      .rejects.toThrow("unsupported archive");
    await expect(readArchiveEntry("missing.zip", "", { maxBytes: 1 }))
      .rejects.toThrow("archive entry is not a file");
    await expect(readArchiveEntry("missing.zip", "dir/", { maxBytes: 1 }))
      .rejects.toThrow("archive entry is not a file");
  });

  it("rejects non-file archive inputs", async () => {
    const root = await tempRoot("fs-safe-read-input-");
    const directory = path.join(root, "directory.zip");
    const target = path.join(root, "target.zip");
    const link = path.join(root, "link.zip");
    await fs.mkdir(directory);
    await fs.writeFile(target, "not a zip");
    await fs.symlink(target, link);

    await expect(readArchiveEntry(directory, "value", { maxBytes: 1 }))
      .rejects.toThrow("archive is not a regular file");
    await expect(readArchiveEntry(link, "value", { maxBytes: 1 }))
      .rejects.toThrow("archive is not a regular file");
  });

  it("reads ZIP entries at the limit and rejects missing, directory, link, and oversized entries", async () => {
    const root = await tempRoot("fs-safe-read-zip-");
    const archivePath = path.join(root, "fixture.zip");
    const zip = new JSZip();
    zip.file("value.txt", "value");
    zip.folder("directory");
    zip.file("link", "target", { unixPermissions: 0o120777 });
    await fs.writeFile(archivePath, await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" }));

    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 5 }))
      .resolves.toEqual(Buffer.from("value"));
    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 4 }))
      .rejects.toMatchObject({
        code: ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
      });
    await expect(readArchiveEntry(archivePath, "missing", { maxBytes: 5 }))
      .rejects.toThrow("archive entry not found");
    await expect(readArchiveEntry(archivePath, "directory", { maxBytes: 5 }))
      .rejects.toThrow("archive entry not found");
    await expect(readArchiveEntry(archivePath, "link", { maxBytes: 16 }))
      .rejects.toThrow("archive entry is a link");
  });

  it("uses the ZIP buffer fallback when a library entry has no node stream", async () => {
    const root = await tempRoot("fs-safe-read-zip-buffer-");
    const archivePath = path.join(root, "fixture.zip");
    const zip = new JSZip();
    zip.file("value.txt", "value");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await fs.writeFile(archivePath, bytes);
    const loaded = await JSZip.loadAsync(bytes);
    const entry = loaded.file("value.txt");
    const prototype = Object.getPrototypeOf(entry) as object;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "nodeStream");
    expect(descriptor).toBeDefined();
    Object.defineProperty(prototype, "nodeStream", { ...descriptor, value: undefined });
    try {
      await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 5 }))
        .resolves.toEqual(Buffer.from("value"));
    } finally {
      Object.defineProperty(prototype, "nodeStream", descriptor!);
    }
  });

  it("rejects missing, non-file, and oversized TAR entries without hanging the parser", async () => {
    const root = await tempRoot("fs-safe-read-tar-");
    const archivePath = path.join(root, "fixture.tar");
    await fs.writeFile(archivePath, tarFixture([
      { path: "directory", type: "5" },
      { path: "value.txt", body: "value" },
    ]));

    await expect(readArchiveEntry(archivePath, "missing", { maxBytes: 5 }))
      .rejects.toThrow("archive entry not found");
    await expect(readArchiveEntry(archivePath, "directory", { maxBytes: 5 }))
      .rejects.toThrow("archive entry is not a file");
    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 4 }))
      .rejects.toMatchObject({
        code: ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
      });
    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 5 }))
      .resolves.toEqual(Buffer.from("value"));
  });

  it("maps native manifest and reader failures to the public archive errors", async () => {
    const root = await tempRoot("fs-safe-read-native-");
    const archivePath = path.join(root, "fixture.zip");
    await fs.writeFile(archivePath, await new JSZip().file("value.txt", "value").generateAsync({
      type: "nodebuffer",
    }));
    let manifest: Array<{ index: number; path: string; kind: string; size: number; mode: number }> = [];
    let readError: Error | undefined;
    const inspectArchiveNative = vi.fn(async () => manifest);
    const readArchiveEntryNative = vi.fn(async () => {
      if (readError) throw readError;
      return Buffer.from("value");
    });
    __setNativeLoaderForTest(() => ({
      inspectArchiveNative,
      readArchiveEntryNative,
    }) as unknown as NativeBinding);
    configureFsSafeNative({ mode: "require" });
    const regular = { index: 0, path: "value.txt", kind: "file", size: 5, mode: 0o644 };

    manifest = [regular, { ...regular, index: 1 }];
    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 5 }))
      .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
    manifest = [{ ...regular, kind: "directory" }];
    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 5 }))
      .rejects.toThrow("archive entry is not a file");
    manifest = [{ ...regular, path: "other.txt" }];
    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 5 }))
      .rejects.toThrow("archive entry not found");
    manifest = [{ ...regular, path: "../escape" }];
    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 5 }))
      .rejects.toMatchObject({ name: "ArchiveSecurityError", code: "entry-path" });
    manifest = [{ ...regular, path: "./value.txt" }];
    readError = new Error(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 5 }))
      .rejects.toBeInstanceOf(ArchiveLimitError);
    readError = new Error("archive-header-invalid: truncated ZIP central directory");
    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 5 }))
      .rejects.toBeInstanceOf(ArchiveFormatError);
    readError = undefined;
    await expect(readArchiveEntry(archivePath, "value.txt", { maxBytes: 5 }))
      .resolves.toEqual(Buffer.from("value"));
    expect(readArchiveEntryNative).toHaveBeenLastCalledWith(
      expect.any(String),
      "zip",
      "./value.txt",
      5,
      expect.any(Number),
      expect.any(Number),
      expect.any(AbortSignal),
    );
  });

  it("requires native support for explicitly selected zstd and bzip2 TAR reads", async () => {
    const root = await tempRoot("fs-safe-read-compressed-");
    const archivePath = path.join(root, "fixture.bin");
    await fs.writeFile(archivePath, "not compressed");

    await expect(readArchiveEntry(archivePath, "value", { maxBytes: 5, kind: "tar-zstd" }))
      .rejects.toMatchObject({ code: "helper-unavailable" });
    await expect(readArchiveEntry(archivePath, "value", { maxBytes: 5, kind: "tar-bzip2" }))
      .rejects.toMatchObject({ code: "helper-unavailable" });
  });
});
