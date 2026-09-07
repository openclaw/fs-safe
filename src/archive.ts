import { createTarEntryPlanner } from "./archive-tar.js";
import { inspectTar, replayTar } from "./archive-tar-stream.js";
import type { AdmittedTarMember } from "./archive-tar-wasm.js";
import { runPinnedWriteHelper } from "./pinned-write.js";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createArchiveOutputPathTracker,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
import {
  createPipelineTimeoutError,
  waitForDeadline,
  withExtractionDeadline,
  type ExtractionDeadline,
} from "./archive-deadline.js";
import {
  assertArchiveEntryCountWithinLimit,
  assertArchiveEntryPathComponentsWithinLimit,
  createByteBudgetTracker,
  createExtractBudgetTransform,
  resolveExtractLimits,
  resolveTarMeterLimits,
  type ArchiveExtractLimits,
  type ResolvedArchiveExtractLimits,
  type TarMeterLimits,
} from "./archive-limits.js";
import { assertPortableArchiveKind, resolveArchiveKind } from "./archive-kind.js";
import {
  prepareArchiveDestinationDir,
  preparePrivateArchiveOutputPath,
  withStagedArchiveDestination,
} from "./archive-staging.js";
import { mergePlannedArchiveIntoDestination, type ArchivePublicationEntry } from "./archive-merge.js";
import { loadZipArchiveWithPreflight } from "./archive-zip-preflight.js";
import {
  isZipSymlinkEntry,
  zipEntryDeclaredSize,
  zipEntryMode,
  type ZipEntry,
} from "./archive-zip-entry.js";
import {
  createZipIntegrityTransform,
  normalizeZipIntegrityError,
} from "./archive-zip-integrity.js";
import { FsSafeError } from "./errors.js";
import { ArchiveSecurityError } from "./archive-errors.js";
import { extractNativeArchive } from "./archive-native.js";
import { stageArchiveFileForExtraction } from "./archive-input.js";
import { getNativeBinding } from "./native.js";
import {
  resolveArchiveFilteredEntryPolicy,
  shouldExtractArchiveEntry,
} from "./archive-policy.js";
import type { ExtractArchiveOptions } from "./archive-options.js";
import { writeSiblingTempFile } from "./sibling-temp.js";
export type { ArchiveLogger, ExtractArchiveOptions } from "./archive-options.js";
export type {
  ArchiveEntryFilter,
  ArchiveEntryKind,
  ArchiveEntryModePolicy,
  ArchiveFilteredEntryPolicy,
} from "./archive-policy.js";
export {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
export { resolveArchiveKind, resolvePackedRootDir, type ArchiveKind } from "./archive-kind.js";
export { readArchiveEntry } from "./archive-read.js";
export { inspectTarArchive, type InspectTarArchiveOptions, type InspectedTarEntry } from "./archive-tar-inspect.js";
export {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_EXTRACTED_BYTES,
  DEFAULT_MAX_ENTRY_BYTES,
  DEFAULT_MAX_META_ENTRY_BYTES,
  DEFAULT_MAX_ENTRY_PATH_COMPONENTS,
  type ArchiveExtractLimits,
  type ArchiveLimitErrorCode,
} from "./archive-limits.js";
export { ArchiveFormatError, type ArchiveFormatErrorCode } from "./archive-errors.js";
export { ArchiveSecurityError, type ArchiveSecurityErrorCode } from "./archive-staging.js";
export {
  createArchiveSymlinkTraversalError,
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  prepareArchiveOutputPath,
  withStagedArchiveDestination,
} from "./archive-staging.js";
export { createTarEntryPreflightChecker, type TarEntryInfo } from "./archive-tar.js";
export {
  loadZipArchiveWithPreflight,
  readZipCentralDirectoryEntryCount,
  type ZipArchiveWithFiles,
} from "./archive-zip-preflight.js";
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_WRITE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
type ZipExtractBudget = ReturnType<typeof createByteBudgetTracker>;

async function readZipEntryStream(entry: ZipEntry): Promise<NodeJS.ReadableStream> {
  if (typeof entry.nodeStream === "function") {
    return entry.nodeStream();
  }
  // Old JSZip: fall back to buffering, but still extract via a stream.
  const buf = await entry.async("nodebuffer");
  return Readable.from(buf);
}

function resolveZipOutputPath(params: {
  entryPath: string;
  strip: number;
  destinationDir: string;
}): { canonicalPath: string; relPath: string; outPath: string } | null {
  validateArchiveEntryPath(params.entryPath);
  const canonicalPath = stripArchivePath(params.entryPath, 0);
  if (!canonicalPath) return null;
  const relPath = stripArchivePath(canonicalPath, params.strip);
  if (!relPath) {
    return null;
  }
  validateArchiveEntryPath(relPath);
  return {
    canonicalPath,
    relPath,
    outPath: resolveArchiveOutputPath({
      rootDir: params.destinationDir,
      relPath,
      originalPath: params.entryPath,
    }),
  };
}

async function writeZipFileEntry(params: {
  entry: ZipEntry;
  outPath: string;
  budget: ZipExtractBudget;
  deadline: ExtractionDeadline;
}): Promise<void> {
  params.deadline.check();
  params.budget.startEntry();
  const readable = await readZipEntryStream(params.entry);
  const destinationPath = params.outPath;

  let tempHandle: FileHandle | null = null;
  let handleClosedByStream = false;

  try {
    await writeSiblingTempFile({
      dir: path.dirname(destinationPath),
      chmodDir: false,
      mode: 0o600,
      writeTemp: async (tempPath) => {
        tempHandle = await fs.open(tempPath, OPEN_WRITE_CREATE_FLAGS, 0o600);
        const writable = tempHandle.createWriteStream();
        writable.once("close", () => {
          handleClosedByStream = true;
        });

        try {
          await pipeline(
            readable,
            createExtractBudgetTransform({ onChunkBytes: params.budget.addBytes }),
            createZipIntegrityTransform(params.entry),
            writable,
            { signal: params.deadline.signal },
          );
        } catch (err) {
          throw normalizeZipIntegrityError(createPipelineTimeoutError(err, params.deadline));
        }
        params.deadline.check();
        if (!handleClosedByStream) {
          await tempHandle.close().catch(() => undefined);
          handleClosedByStream = true;
        }
        tempHandle = null;
        return destinationPath;
      },
      resolveFinalPath: (filePath) => filePath,
    });
  } catch (err) {
    // Failures here happen before the temp has been committed. The destination
    // parent may already be untrusted, so cleanup must stay limited to temp state.
    throw err;
  } finally {
    const openTempHandle = tempHandle as FileHandle | null;
    if (openTempHandle && !handleClosedByStream) {
      await openTempHandle.close().catch(() => undefined);
    }
  }
}

async function extractZip(params: {
  archivePath: string;
  destDir: string;
  stripComponents?: number;
  limits?: ArchiveExtractLimits;
  deadline: ExtractionDeadline;
  entryModes?: ExtractArchiveOptions["entryModes"];
  entryFilter?: ExtractArchiveOptions["entryFilter"];
  onFiltered?: ExtractArchiveOptions["onFiltered"];
}): Promise<void> {
  const limits = resolveExtractLimits(params.limits);
  const stagedArchive = await stageArchiveFileForExtraction({
    archivePath: params.archivePath,
    limits,
    deadline: params.deadline,
  });
  try {
    const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
    params.deadline.check();
    const buffer = await fs.readFile(stagedArchive.path, { signal: params.deadline.signal });
    params.deadline.check();
    const zip = await waitForDeadline(loadZipArchiveWithPreflight(buffer, limits), params.deadline);
    params.deadline.check();
    const entries = Object.values(zip.files) as ZipEntry[];
    const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));

    assertArchiveEntryCountWithinLimit(entries.length, limits);

    const budget = createByteBudgetTracker(limits);
    const trackOutputPath = createArchiveOutputPathTracker();

    await withStagedArchiveDestination({
      destinationRealDir,
      run: async (stagingDir) => {
        const stagingRealDir = await fs.realpath(stagingDir);
        const acceptedEntries: ArchivePublicationEntry[] = [];
        for (const entry of entries) {
          params.deadline.check();
          const output = resolveZipOutputPath({
            entryPath: entry.name,
            strip,
            destinationDir: stagingRealDir,
          });
          if (!output) {
            continue;
          }
          assertArchiveEntryPathComponentsWithinLimit(output.relPath, limits);
          trackOutputPath(output.relPath, entry.name);

          const isSymlink = isZipSymlinkEntry(entry);
          const entryKind = isSymlink ? "symlink" : entry.dir ? "directory" : "file";
          const entrySize = zipEntryDeclaredSize(entry);
          if (
            !shouldExtractArchiveEntry({
              filter: params.entryFilter,
              onFiltered: params.onFiltered,
              entry: { path: output.canonicalPath, kind: entryKind, size: entrySize },
            })
          ) {
            continue;
          }
          if (isSymlink) {
            throw new ArchiveSecurityError("entry-link", `zip entry is a link: ${entry.name}`);
          }
          const mode = zipEntryMode(entry, params.entryModes);
          acceptedEntries.push({ path: output.relPath, kind: entry.dir ? "directory" : "file", mode });

          await preparePrivateArchiveOutputPath({
            destinationDir: stagingRealDir,
            destinationRealDir: stagingRealDir,
            relPath: output.relPath,
            outPath: output.outPath,
            originalPath: entry.name,
            isDirectory: entry.dir,
            deadline: params.deadline,
          });
          if (entry.dir) {
            continue;
          }

          await writeZipFileEntry({
            entry,
            outPath: output.outPath,
            budget,
            deadline: params.deadline,
          });
        }

        params.deadline.check();
        await mergePlannedArchiveIntoDestination({
          entries: acceptedEntries,
          sourceDir: stagingRealDir,
          destinationDir: params.destDir,
          destinationRealDir,
          deadline: params.deadline,
        });
        params.deadline.check();
      },
    });
  } finally {
    await stagedArchive.cleanup();
  }
}

export async function extractArchive(params: ExtractArchiveOptions): Promise<void> {
  const onFiltered = resolveArchiveFilteredEntryPolicy(params.onFiltered);
  const kind = params.kind ?? resolveArchiveKind(params.archivePath);
  if (!kind) {
    throw new Error(`unsupported archive: ${params.archivePath}`);
  }

  const label = kind === "zip" ? "extract zip" : "extract tar";
  const limits = resolveExtractLimits(params.limits);
  const tarLimits = resolveTarMeterLimits(limits);
  const native = getNativeBinding();
  if (native) {
    await withExtractionDeadline(params.timeoutMs, label, async (deadline) =>
      extractNativeArchive({
        binding: native,
        archivePath: params.archivePath,
        destDir: params.destDir,
        kind,
        stripComponents: params.stripComponents,
        limits,
        tarLimits,
        deadline,
        entryModes: params.entryModes,
        entryFilter: params.entryFilter,
        onFiltered,
      }),
    );
    return;
  }
  assertPortableArchiveKind(kind);
  if (kind === "tar") {
    await withExtractionDeadline(params.timeoutMs, label, async (deadline) => {
      const stagedArchive = await stageArchiveFileForExtraction({
        archivePath: params.archivePath,
        limits,
        deadline,
      });
      try {
        await extractWasmTar({ archivePath: stagedArchive.path, options: { ...params, onFiltered }, limits, tarLimits, deadline });
      } finally {
        await stagedArchive.cleanup();
      }
    });
    return;
  }

  await withExtractionDeadline(params.timeoutMs, label, async (deadline) =>
    extractZip({
      archivePath: params.archivePath,
      destDir: params.destDir,
      stripComponents: params.stripComponents,
      limits,
      deadline,
      entryModes: params.entryModes,
      entryFilter: params.entryFilter,
      onFiltered,
    }),
  );
}

async function extractWasmTar(params: {
  archivePath: string; options: ExtractArchiveOptions; limits: ResolvedArchiveExtractLimits;
  tarLimits: TarMeterLimits; deadline: ExtractionDeadline;
}): Promise<void> {
  const { options, deadline, tarLimits } = params;
  const manifest: AdmittedTarMember[] = [];
  await inspectTar({ archivePath: params.archivePath, limits: tarLimits, signal: deadline.signal,
    onMember: (entry) => { manifest.push(entry); } });
  deadline.check();
  const destinationRealDir = await prepareArchiveDestinationDir(options.destDir);
  await withStagedArchiveDestination({ destinationRealDir, run: async (stagingPath) => {
    const stagingDir = await fs.realpath(stagingPath);
    const planEntry = createTarEntryPlanner({ ...options, rootDir: destinationRealDir, limits: params.limits });
    const accepted = manifest.flatMap((entry) => {
      deadline.check();
      const planned = planEntry(entry);
      return planned ? [{ ...entry, ...planned }] : [];
    });
    await replayTar({ archivePath: params.archivePath, limits: tarLimits, signal: deadline.signal, members: accepted,
      async consume(member, payload) {
        deadline.check();
        await preparePrivateArchiveOutputPath({ destinationDir: stagingDir, destinationRealDir: stagingDir,
          relPath: member.path, outPath: path.join(stagingDir, member.path), originalPath: member.path,
          isDirectory: member.kind === "directory", deadline });
        if (member.kind === "file") {
          await runPinnedWriteHelper({ rootPath: stagingDir, relativeParentPath: path.posix.dirname(member.path),
            basename: path.posix.basename(member.path), mkdir: false, mode: 0o600, overwrite: false,
            maxBytes: member.size, input: { kind: "stream", stream: Readable.from(payload) } });
        }
        deadline.check();
      },
    });
    deadline.check();
    await mergePlannedArchiveIntoDestination({ entries: accepted, sourceDir: stagingDir,
      destinationDir: options.destDir, destinationRealDir, deadline });
    deadline.check();
  } });
}
