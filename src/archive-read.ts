import { classifyArchiveParserError } from "./archive-parser-errors.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { readBoundedAsync } from "./bounded-read.js";
import {
  ArchiveFormatError,
  ArchiveSecurityError,
  isArchiveFormatErrorMessage,
} from "./archive-errors.js";
import { formatErrorDetail } from "./error-detail.js";
import {
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
import { assertPortableArchiveKind, resolveArchiveKind, type ArchiveKind } from "./archive-kind.js";
import {
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  ArchiveLimitError,
  ARCHIVE_LIMIT_ERROR_CODE,
} from "./archive-limits.js";
import { inspectTar, replayTar } from "./archive-tar-stream.js";
import type { AdmittedTarMember } from "./archive-tar-wasm.js";
import { loadZipArchiveWithPreflight } from "./archive-zip-preflight.js";
import {
  createZipIntegrityTransform,
  normalizeZipIntegrityError,
} from "./archive-zip-integrity.js";
import type { ZipEntry } from "./archive-zip-entry.js";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { getNativeBinding, type NativeBinding } from "./native.js";
import type { NativeArchiveEntry } from "./native-binding.js";
import { admitZipBuffer } from "./archive-zip-admission.js";
import { resolveExtractLimits, resolveTarMeterLimits } from "./archive-limits.js";
import { tempFile } from "./temp-target.js";

const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_SYMLINK_TYPE = 0o120000;

function canonicalEntryPath(entryPath: string): string {
  validateArchiveEntryPath(entryPath, { escapeLabel: "archive root" });
  return stripArchivePath(entryPath, 0) ?? "";
}

function normalizedRequestedEntry(entryPath: string): string {
  const normalized = canonicalEntryPath(entryPath);
  if (!normalized || /[/\\]$/.test(entryPath)) {
    throw new Error(`archive entry is not a file: ${formatErrorDetail(entryPath)}`);
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

async function readArchiveInput(archivePath: string): Promise<Buffer> {
  const resolved = fsSync.realpathSync.native(archivePath);
  const before = await inspectFileIdentity(async () => {
    const stat = fsSync.lstatSync(archivePath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`archive is not a regular file: ${archivePath}`);
    }
    return stat;
  });
  const handle = await fs.open(resolved, resolveReadOpenFlags());
  try {
    const opened = await inspectFileIdentity(async () => {
      const stat = fsSync.fstatSync(handle.fd, { bigint: true });
      if (!stat.isFile()) throw new Error("archive changed during validation");
      return stat;
    }, before);
    await inspectFileIdentity(async () => {
      const stat = fsSync.lstatSync(resolved, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("archive changed during validation");
      return stat;
    }, opened);

    // Native ZIP workers borrow this private buffer. A pooled allocation could
    // share its ArrayBuffer with unrelated JS buffers while the worker runs.
    return await readBoundedAsync(DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
      async (buffer, length) => (await handle.read(buffer, 0, length, null)).bytesRead,
      { unpooled: true, observeRegularFileSize: () => {
        const size = fsSync.fstatSync(handle.fd).size;
        return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
      } },
    );
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "path-mismatch") {
      throw new FsSafeError("path-mismatch", "archive changed during validation", { cause: error });
    }
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
  let entry: ZipEntry | undefined;
  // JSZip keys retain some aliases and may use Unicode Path metadata. Scan the
  // effective entries once, after raw ZIP admission has rejected collisions.
  for (const candidate of Object.values(archive.files) as ZipEntry[]) {
    if (canonicalEntryPath(candidate.name) !== entryPath) continue;
    if (entry) {
      throw new ArchiveSecurityError("entry-path", `archive contains duplicate entry path: ${formatErrorDetail(entryPath)}`);
    }
    entry = candidate;
  }
  if (!entry || entry.dir) {
    throw new Error(`archive entry not found: ${formatErrorDetail(entryPath)}`);
  }
  if (
    typeof entry.unixPermissions === "number" &&
    (entry.unixPermissions & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_SYMLINK_TYPE
  ) {
    throw new Error(`archive entry is a link: ${formatErrorDetail(entryPath)}`);
  }
  const stream: NodeJS.ReadableStream =
    typeof entry.nodeStream === "function"
      ? entry.nodeStream()
      : Readable.from(await entry.async("nodebuffer"));
  const integrity = createZipIntegrityTransform(entry);
  stream.once("error", (error: Error) => integrity.destroy(normalizeZipIntegrityError(error)));
  return await readStreamBounded(stream.pipe(integrity), maxBytes);
}

async function readTarEntry(archivePath: string, entryPath: string, maxBytes: number): Promise<Buffer> {
  const seenPaths = new Set<string>();
  let selected: AdmittedTarMember | undefined;
  const limits = resolveTarMeterLimits();
  await inspectTar({ archivePath, limits, onMember(info) {
    const normalized = canonicalEntryPath(info.path);
    if (seenPaths.has(normalized)) {
      throw new ArchiveSecurityError("entry-path", `archive contains duplicate entry path: ${formatErrorDetail(normalized)}`);
    }
    seenPaths.add(normalized);
    if (normalized === entryPath) selected = info;
  } });
  if (!selected) throw new Error(`archive entry not found: ${formatErrorDetail(entryPath)}`);
  if (!["File", "OldFile", "ContiguousFile"].includes(selected.type)) {
    throw new Error(`archive entry is not a file: ${formatErrorDetail(entryPath)}`);
  }
  if (selected.size > maxBytes) throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
  let result: Buffer | undefined;
  await replayTar({ archivePath, limits, members: [selected], async consume(_member, payload) {
    result = await readStreamBounded(payload, maxBytes);
  } });
  return result!;
}

function selectNativeEntry(
  manifest: NativeArchiveEntry[], requested: string, displayPath: string, physicalCount?: number,
): NativeArchiveEntry {
  if (physicalCount !== undefined && manifest.length !== physicalCount) {
    throw new ArchiveSecurityError("entry-path", "zip decoder collapsed entry names");
  }
  const seen = new Set<string>();
  let selected: NativeArchiveEntry | undefined;
  for (const entry of manifest) {
    const normalized = canonicalEntryPath(entry.path);
    if (seen.has(normalized)) {
      throw new ArchiveSecurityError("entry-path", `archive contains duplicate entry path: ${formatErrorDetail(normalized)}`);
    }
    seen.add(normalized);
    if (normalized === requested) {
      if (entry.kind !== "file") throw new Error(`archive entry is not a file: ${formatErrorDetail(displayPath)}`);
      selected = entry;
    }
  }
  if (!selected) throw new Error(`archive entry not found: ${formatErrorDetail(displayPath)}`);
  return selected;
}

function throwNativeReadError(error: unknown): never {
  if (error instanceof Error) {
    const mapped = classifyArchiveParserError(error.message, { cause: error });
    if (mapped) throw mapped;
    if (isArchiveFormatErrorMessage(error.message)) throw new ArchiveFormatError(error.message, { cause: error });
  }
  throw error;
}

async function readNativeZipEntry(
  native: NativeBinding, buffer: Buffer, requested: string, displayPath: string, maxBytes: number, physicalCount: number,
): Promise<Buffer> {
  try {
    const signal = new AbortController().signal;
    const reader = await native.openZipBufferNative(buffer, resolveTarMeterLimits(), AbortSignal.any([signal]));
    const selected = selectNativeEntry(reader.entries, requested, displayPath, physicalCount);
    return await reader.readEntry(selected.index, maxBytes, AbortSignal.any([signal]));
  } catch (error) {
    throwNativeReadError(error);
  }
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
  const buffer = await readArchiveInput(archivePath);
  const physicalCount = kind === "zip"
    ? admitZipBuffer(buffer, resolveExtractLimits())
    : undefined;
  const native = getNativeBinding();
  if (kind === "zip" && native) {
    return await readNativeZipEntry(native, buffer, requestedEntry, entryPath, options.maxBytes, physicalCount!);
  }
  if (!native) {
    assertPortableArchiveKind(kind);
    if (kind === "zip") return await readZipEntry(buffer, requestedEntry, options.maxBytes);
  }
  const staged = await tempFile({ prefix: "fs-safe-archive-read", fileName: "archive.bin" });
  try {
    await fs.writeFile(staged.path, buffer, { flag: "wx", mode: 0o600 });
    if (native) {
      try {
        const signal = new AbortController().signal;
        const limits = resolveTarMeterLimits();
        const manifest = await native.inspectArchiveNative(
          staged.path,
          kind,
          limits,
          signal,
        );
        const selected = selectNativeEntry(manifest, requestedEntry, entryPath);
        return await native.readArchiveEntryNative(
          staged.path,
          kind,
          selected.path,
          options.maxBytes,
          limits,
          signal,
        );
      } catch (error) {
        throwNativeReadError(error);
      }
    }
    return await readTarEntry(staged.path, requestedEntry, options.maxBytes);
  } finally {
    await staged.cleanup();
  }
}
