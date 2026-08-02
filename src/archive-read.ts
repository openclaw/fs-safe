import fsSync from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { readFileHandleBounded } from "./bounded-read.js";
import { ArchiveFormatError, ArchiveSecurityError } from "./archive-errors.js";
import {
  normalizeArchiveEntryPath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
import { resolveArchiveKind, type ArchiveKind } from "./archive-kind.js";
import {
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_META_ENTRY_BYTES,
  ArchiveLimitError,
  ARCHIVE_LIMIT_ERROR_CODE,
} from "./archive-limits.js";
import { readTarEntryInfo } from "./archive-tar.js";
import { preflightTarMetadata } from "./archive-tar-meta.js";
import { importOptionalTar } from "./archive-tar-runtime.js";
import { loadZipArchiveWithPreflight } from "./archive-zip-preflight.js";
import { createZipIntegrityTransform } from "./archive-zip-integrity.js";
import type { ZipEntry } from "./archive-zip-entry.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { getNativeBinding } from "./native.js";
import { tempFile } from "./temp-target.js";

const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_SYMLINK_TYPE = 0o120000;

function normalizedRequestedEntry(entryPath: string): string {
  validateArchiveEntryPath(entryPath, { escapeLabel: "archive root" });
  const normalized = normalizeArchiveEntryPath(entryPath).replace(/^\.\//, "");
  if (!normalized || normalized.endsWith("/")) {
    throw new Error(`archive entry is not a file: ${entryPath}`);
  }
  return normalized;
}

async function readStreamBounded(
  stream: NodeJS.ReadableStream | AsyncIterable<unknown>,
  maxBytes: number,
): Promise<Buffer> {
  if (!(Symbol.asyncIterator in Object(stream))) {
    return await new Promise<Buffer>((resolve, reject) => {
      const readable = stream as NodeJS.ReadableStream;
      const chunks: Buffer[] = [];
      let total = 0;
      readable.on("data", (chunk: unknown) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buffer.length;
        if (total > maxBytes) {
          readable.pause();
          reject(
            new ArchiveLimitError(
              ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
            ),
          );
          return;
        }
        chunks.push(buffer);
      });
      readable.once("end", () => resolve(Buffer.concat(chunks, total)));
      readable.once("error", reject);
    });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<unknown>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function stageArchiveInput(archivePath: string): Promise<{
  path: string;
  buffer: Buffer;
  cleanup(): Promise<void>;
}> {
  const resolved = await fs.realpath(archivePath);
  const before = await fs.lstat(archivePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`archive is not a regular file: ${archivePath}`);
  }
  const noFollow =
    process.platform !== "win32" && typeof fsSync.constants.O_NOFOLLOW === "number"
      ? fsSync.constants.O_NOFOLLOW
      : 0;
  const handle = await fs.open(resolved, fsSync.constants.O_RDONLY | noFollow);
  const staged = await tempFile({ prefix: "fs-safe-archive-read", fileName: "archive.bin" });
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(resolved);
    if (
      !opened.isFile() ||
      !current.isFile() ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(current, opened)
    ) {
      throw new Error("archive changed during validation");
    }
    const buffer = await readFileHandleBounded(handle, DEFAULT_MAX_ARCHIVE_BYTES_ZIP);
    await fs.writeFile(staged.path, buffer, { flag: "wx", mode: 0o600 });
    return { path: staged.path, buffer, cleanup: staged.cleanup };
  } catch (error) {
    await staged.cleanup().catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readZipEntry(buffer: Buffer, entryPath: string, maxBytes: number): Promise<Buffer> {
  const archive = await loadZipArchiveWithPreflight(buffer, {
    maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
    maxEntryBytes: maxBytes,
    maxExtractedBytes: maxBytes,
  });
  const entry = (archive.files as Record<string, ZipEntry>)[entryPath];
  if (!entry || entry.dir) {
    throw new Error(`archive entry not found: ${entryPath}`);
  }
  if (
    typeof entry.unixPermissions === "number" &&
    (entry.unixPermissions & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_SYMLINK_TYPE
  ) {
    throw new Error(`archive entry is a link: ${entryPath}`);
  }
  const stream =
    typeof entry.nodeStream === "function"
      ? entry.nodeStream()
      : Readable.from(await entry.async("nodebuffer"));
  return await readStreamBounded(stream.pipe(createZipIntegrityTransform(entry)), maxBytes);
}

async function readTarEntry(archivePath: string, entryPath: string, maxBytes: number): Promise<Buffer> {
  const tar = await importOptionalTar();
  await preflightTarMetadata({
    archivePath,
    maxMetaEntryBytes: DEFAULT_MAX_META_ENTRY_BYTES,
  });
  let matched: Promise<Buffer> | undefined;
  let entryError: Error | undefined;
  const seenPaths = new Set<string>();
  await tar.t({
    file: archivePath,
    strict: true,
    maxMetaEntrySize: DEFAULT_MAX_META_ENTRY_BYTES,
    onReadEntry(entry) {
      const info = readTarEntryInfo(entry);
      validateArchiveEntryPath(info.path, { escapeLabel: "archive root" });
      const normalized = normalizeArchiveEntryPath(info.path).replace(/^\.\//, "");
      if (seenPaths.has(normalized)) {
        entryError ??= new ArchiveSecurityError(
          "entry-path",
          `archive contains duplicate entry path: ${normalized}`,
        );
        entry.resume();
        return;
      }
      seenPaths.add(normalized);
      if (normalized !== entryPath) {
        entry.resume();
        return;
      }
      if (info.type !== "File" && info.type !== "OldFile" && info.type !== "ContiguousFile") {
        entryError ??= new Error(`archive entry is not a file: ${entryPath}`);
        entry.resume();
        return;
      }
      if (info.size > maxBytes) {
        entryError ??= new ArchiveLimitError(
          ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
        );
        entry.resume();
        return;
      }
      matched = readStreamBounded(entry, maxBytes);
    },
  });
  if (entryError) {
    throw entryError;
  }
  if (!matched) {
    throw new Error(`archive entry not found: ${entryPath}`);
  }
  return await matched;
}

export async function readArchiveEntry(
  archivePath: string,
  entryPath: string,
  options: { maxBytes: number; kind?: ArchiveKind },
): Promise<Buffer> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const kind = options.kind ?? resolveArchiveKind(archivePath);
  if (!kind) {
    throw new Error(`unsupported archive: ${archivePath}`);
  }
  const requestedEntry = normalizedRequestedEntry(entryPath);
  const staged = await stageArchiveInput(archivePath);
  try {
    const native = getNativeBinding();
    if (native) {
      try {
        const signal = new AbortController().signal;
        const manifest = await native.inspectArchiveNative(
          staged.path,
          kind,
          DEFAULT_MAX_ENTRIES,
          DEFAULT_MAX_META_ENTRY_BYTES,
          DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
          signal,
        );
        let rawEntryPath: string | undefined;
        const seenPaths = new Set<string>();
        for (const entry of manifest) {
          validateArchiveEntryPath(entry.path, { escapeLabel: "archive root" });
          const normalized = normalizeArchiveEntryPath(entry.path).replace(/^\.\//, "");
          if (seenPaths.has(normalized)) {
            throw new ArchiveSecurityError(
              "entry-path",
              `archive contains duplicate entry path: ${normalized}`,
            );
          }
          seenPaths.add(normalized);
          if (normalized === requestedEntry) {
            if (entry.kind !== "file") {
              throw new Error(`archive entry is not a file: ${entryPath}`);
            }
            rawEntryPath = entry.path;
          }
        }
        if (!rawEntryPath) throw new Error(`archive entry not found: ${entryPath}`);
        return await native.readArchiveEntryNative(
          staged.path,
          kind,
          rawEntryPath,
          options.maxBytes,
          DEFAULT_MAX_ENTRIES,
          DEFAULT_MAX_META_ENTRY_BYTES,
          signal,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT)
        ) {
          throw new ArchiveLimitError(
            ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
          );
        }
        if (error instanceof Error && error.message.includes("archive-header-invalid")) {
          throw new ArchiveFormatError(error.message, { cause: error });
        }
        throw error;
      }
    }
    if (kind === "tar-zstd" || kind === "tar-bzip2") {
      throw new FsSafeError(
        "helper-unavailable",
        `${kind} archives require a supported bundled native binding`,
      );
    }
    return kind === "zip"
      ? await readZipEntry(staged.buffer, requestedEntry, options.maxBytes)
      : await readTarEntry(staged.path, requestedEntry, options.maxBytes);
  } finally {
    await staged.cleanup();
  }
}
