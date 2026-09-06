import { classifyArchiveParserError } from "./archive-parser-errors.js";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { readFileHandleBounded } from "./bounded-read.js";
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
import { getNativeBinding } from "./native.js";
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

async function stageArchiveInput(archivePath: string): Promise<{
  path: string;
  buffer: Buffer;
  cleanup(): Promise<void>;
}> {
  const resolved = await fs.realpath(archivePath);
  const before = await inspectFileIdentity(async () => {
    const stat = await fs.lstat(archivePath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`archive is not a regular file: ${archivePath}`);
    }
    return stat;
  });
  const handle = await fs.open(resolved, resolveReadOpenFlags());
  let staged: Awaited<ReturnType<typeof tempFile>> | undefined;
  try {
    staged = await tempFile({ prefix: "fs-safe-archive-read", fileName: "archive.bin" });
    const opened = await inspectFileIdentity(async () => {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) throw new Error("archive changed during validation");
      return stat;
    }, before);
    await inspectFileIdentity(async () => {
      const stat = await fs.lstat(resolved, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("archive changed during validation");
      return stat;
    }, opened);

    const buffer = await readFileHandleBounded(handle, DEFAULT_MAX_ARCHIVE_BYTES_ZIP);
    await fs.writeFile(staged.path, buffer, { flag: "wx", mode: 0o600 });
    return { path: staged.path, buffer, cleanup: staged.cleanup };
  } catch (error) {
    await staged?.cleanup().catch(() => undefined);
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
    const physicalCount = kind === "zip"
      ? admitZipBuffer(staged.buffer, resolveExtractLimits())
      : undefined;
    const native = getNativeBinding();
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
        let rawEntryPath: string | undefined;
        if (physicalCount !== undefined && manifest.length !== physicalCount) {
          throw new ArchiveSecurityError("entry-path", "zip decoder collapsed entry names");
        }
        const seenPaths = new Set<string>();
        for (const entry of manifest) {
          const normalized = canonicalEntryPath(entry.path);
          if (seenPaths.has(normalized)) {
            throw new ArchiveSecurityError(
              "entry-path",
              `archive contains duplicate entry path: ${formatErrorDetail(normalized)}`,
            );
          }
          seenPaths.add(normalized);
          if (normalized === requestedEntry) {
            if (entry.kind !== "file") {
              throw new Error(
                `archive entry is not a file: ${formatErrorDetail(entryPath)}`,
              );
            }
            rawEntryPath = entry.path;
          }
        }
        if (!rawEntryPath) {
          throw new Error(`archive entry not found: ${formatErrorDetail(entryPath)}`);
        }
        return await native.readArchiveEntryNative(
          staged.path,
          kind,
          rawEntryPath,
          options.maxBytes,
          limits,
          signal,
        );
      } catch (error) {
        if (error instanceof Error) {
          const mapped = classifyArchiveParserError(error.message, { cause: error });
          if (mapped) throw mapped;
        }
        if (error instanceof Error && isArchiveFormatErrorMessage(error.message)) {
          throw new ArchiveFormatError(error.message, { cause: error });
        }
        throw error;
      }
    }
    assertPortableArchiveKind(kind);
    return kind === "zip"
      ? await readZipEntry(staged.buffer, requestedEntry, options.maxBytes)
      : await readTarEntry(staged.path, requestedEntry, options.maxBytes);
  } finally {
    await staged.cleanup();
  }
}
