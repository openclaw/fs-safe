import { classifyArchiveParserError } from "./archive-parser-errors.js";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
import { resolveArchiveKind, type ArchiveKind } from "./archive-kind.js";
import {
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  ArchiveLimitError,
  ARCHIVE_LIMIT_ERROR_CODE,
} from "./archive-limits.js";
import { isGzipBuffer } from "./archive-gzip-tail.js";
import { inspectTar, replayTar } from "./archive-tar-stream.js";
import type { AdmittedTarMember } from "./archive-tar-wasm.js";
import { loadAdmittedZipArchive, assertZipEntryBinding } from "./archive-zip-loader.js";
import {
  createZipIntegrityTransform,
  normalizeZipIntegrityError,
} from "./archive-zip-integrity.js";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { realpathSync } from "./realpath.js";
import { getNativeBinding, type NativeBinding } from "./native.js";
import type { NativeArchiveEntry } from "./native-binding.js";
import { admitZipBuffer } from "./archive-zip-admission.js";
import type { ZipDirectoryEntry } from "./archive-zip-directory.js";
import { validateNativeZipManifest } from "./archive-zip-manifest.js";
import { resolveExtractLimits, resolveTarMeterLimits } from "./archive-limits.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

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

async function readAdmittedTarPayload(
  stream: AsyncIterable<Buffer>,
  size: number,
): Promise<Buffer> {
  // Complete admission has bounded this exact range. Copy as it arrives so
  // decoder chunks can be released before the caller receives the owned result.
  const result = Buffer.allocUnsafe(size);
  let total = 0;
  for await (const chunk of stream) {
    if (chunk.length > size - total) {
      throw new ArchiveFormatError("invalid admitted TAR payload size");
    }
    chunk.copy(result, total);
    total += chunk.length;
  }
  if (total !== size) throw new ArchiveFormatError("truncated admitted TAR range");
  return result;
}

async function readArchiveInput(archivePath: string): Promise<Buffer> {
  assertNoWindowsPathAlias(archivePath);
  const resolved = realpathSync.native(archivePath);
  assertNoWindowsPathAlias(resolved);
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

    // Native archive workers borrow this private buffer. A pooled allocation could
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

async function readZipEntry(buffer: Buffer, entryPath: string, maxBytes: number, admitted: ZipDirectoryEntry[]): Promise<Buffer> {
  const { archive, entries } = await loadAdmittedZipArchive(buffer, admitted);
  const record = entries.get(entryPath);
  if (!record || record.entry.dir) {
    throw new Error(`archive entry not found: ${formatErrorDetail(entryPath)}`);
  }
  assertZipEntryBinding(archive, record, entryPath);
  const { entry, kind } = record;
  if (kind === "symlink") {
    throw new Error(`archive entry is a link: ${formatErrorDetail(entryPath)}`);
  }
  if (kind !== "file") throw new Error(`archive entry is not a file: ${formatErrorDetail(entryPath)}`);
  const integrity = createZipIntegrityTransform(record);
  const stream: NodeJS.ReadableStream =
    typeof entry.nodeStream === "function"
      ? entry.nodeStream()
      : Readable.from(await entry.async("nodebuffer"));
  const chunks: Buffer[] = [];
  let total = 0;
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT));
        return;
      }
      chunks.push(chunk);
      callback();
    },
  });
  try {
    // Iterator teardown can mask limit errors on Node 22; keep them in stream callbacks.
    await pipeline(stream, integrity, destination);
    return Buffer.concat(chunks, total);
  } catch (error) {
    throw normalizeZipIntegrityError(error);
  }
}

async function readTarEntry(archiveBuffer: Buffer, entryPath: string, maxBytes: number, kind: Exclude<ArchiveKind, "zip">): Promise<Buffer> {
  const seenPaths = new Set<string>();
  let selected: AdmittedTarMember | undefined;
  const limits = resolveTarMeterLimits();
  await inspectTar({ archiveBuffer, kind, limits, onMember(info) {
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
  if (kind === "tar" && !isGzipBuffer(archiveBuffer)) {
    // Complete admission already validated this private snapshot through EOF.
    // Copy the admitted payload so the result cannot expose or mutate its input.
    const end = selected.offset + selected.size;
    if (!Number.isSafeInteger(selected.offset) || selected.offset < 0 ||
        !Number.isSafeInteger(end) || end < selected.offset || end > archiveBuffer.length) {
      throw new ArchiveFormatError("invalid admitted TAR range");
    }
    return Buffer.from(archiveBuffer.subarray(selected.offset, end));
  }
  let result: Buffer | undefined;
  await replayTar({ archiveBuffer, kind, limits, members: [selected], async consume(member, payload) {
    result = await readAdmittedTarPayload(payload, member.size);
  } });
  return result!;
}

function selectNativeEntry(
  manifest: NativeArchiveEntry[], requested: string, displayPath: string,
): NativeArchiveEntry {
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

async function readNativeBufferEntry(
  native: NativeBinding, buffer: Buffer, kind: ArchiveKind, requested: string, displayPath: string, maxBytes: number, zipEntries: ZipDirectoryEntry[],
): Promise<Buffer> {
  try {
    const signal = new AbortController().signal;
    const limits = resolveTarMeterLimits();
    const reader = kind === "zip"
      ? await native.openZipBufferNative(buffer, limits, AbortSignal.any([signal]))
      : await native.openTarBufferNative(buffer, kind, limits, AbortSignal.any([signal]));
    const manifest = reader.entries;
    if (kind === "zip") validateNativeZipManifest(manifest, zipEntries);
    const selected = selectNativeEntry(manifest, requested, displayPath);
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
  assertNoWindowsPathAlias(archivePath, "filesystem", "archive source uses a Windows filesystem namespace alias");
  const buffer = await readArchiveInput(archivePath);
  const zipEntries: ZipDirectoryEntry[] = [];
  if (kind === "zip") admitZipBuffer(buffer, resolveExtractLimits(), entry => { zipEntries.push(entry); });
  const native = getNativeBinding();
  if (native) return await readNativeBufferEntry(native, buffer, kind, requestedEntry, entryPath, options.maxBytes, zipEntries);
  return kind === "zip" ? await readZipEntry(buffer, requestedEntry, options.maxBytes, zipEntries)
    : await readTarEntry(buffer, requestedEntry, options.maxBytes, kind);
}
