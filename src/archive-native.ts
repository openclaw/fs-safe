import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { ArchiveFormatError, ArchiveSecurityError } from "./archive-errors.js";
import {
  createArchiveOutputPathTracker,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
import type { ExtractionDeadline } from "./archive-deadline.js";
import { stageArchiveFileForExtraction } from "./archive-input.js";
import type { ArchiveKind } from "./archive-kind.js";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  assertArchiveEntryCountWithinLimit,
  assertArchiveEntryPathComponentsWithinLimit,
  createByteBudgetTracker,
  resolveExtractLimits,
  type ArchiveExtractLimits,
} from "./archive-limits.js";
import type { ExtractArchiveOptions } from "./archive-options.js";
import { resolveArchiveEntryMode, shouldExtractArchiveEntry } from "./archive-policy.js";
import {
  mergeExtractedTreeIntoDestination,
  prepareArchiveDestinationDir,
  withStagedArchiveDestination,
} from "./archive-staging.js";
import type { NativeBinding } from "./native.js";

function policyKind(kind: string): "file" | "directory" | "symlink" | "other" {
  if (kind === "file" || kind === "directory") return kind;
  if (kind === "symlink" || kind === "hardlink") return "symlink";
  return "other";
}

function throwMappedNativeError(error: unknown): never {
  if (error instanceof Error) {
    for (const code of Object.values(ARCHIVE_LIMIT_ERROR_CODE)) {
      if (error.message.includes(code)) throw new ArchiveLimitError(code);
    }
    if (error.message.includes("archive-header-invalid")) {
      throw new ArchiveFormatError(error.message, { cause: error });
    }
  }
  throw error;
}

export async function extractNativeArchive(params: {
  binding: NativeBinding;
  archivePath: string;
  destDir: string;
  kind: ArchiveKind;
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
    await withStagedArchiveDestination({
      destinationRealDir,
      run: async (stagingDir) => {
        params.deadline.check();
        const manifest = await params.binding
          .inspectArchiveNative(
            stagedArchive.path,
            params.kind,
            limits.maxEntries,
            limits.maxMetaEntryBytes,
            limits.maxArchiveBytes,
            params.deadline.signal,
          )
          .catch(throwMappedNativeError);
        params.deadline.check();
        assertArchiveEntryCountWithinLimit(manifest.length, limits);
        const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
        const budget = createByteBudgetTracker(limits);
        const trackOutputPath = createArchiveOutputPathTracker();
        const plan: Array<{
          index: number;
          path: string;
          kind: string;
          size: number;
          mode: number;
        }> = [];

        for (const entry of manifest) {
          params.deadline.check();
          validateArchiveEntryPath(entry.path);
          const relPath = stripArchivePath(entry.path, strip);
          if (!relPath) continue;
          validateArchiveEntryPath(relPath);
          assertArchiveEntryPathComponentsWithinLimit(relPath, limits);
          trackOutputPath(relPath, entry.path);
          resolveArchiveOutputPath({ rootDir: stagingDir, relPath, originalPath: entry.path });
          const kind = policyKind(entry.kind);
          if (
            !shouldExtractArchiveEntry({
              filter: params.entryFilter,
              onFiltered: params.onFiltered,
              entry: { path: entry.path, kind, size: entry.size },
            })
          ) {
            continue;
          }
          if (entry.kind === "sparse") {
            throw new ArchiveFormatError(
              `GNU sparse archive entry is not supported: ${entry.path}`,
            );
          }
          if (kind === "symlink") {
            const label = params.kind === "zip" ? "zip" : "tar";
            throw new ArchiveSecurityError(
              "entry-link",
              `${label} entry is a link: ${entry.path}`,
            );
          }
          if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
            throw new ArchiveLimitError(
              ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
            );
          }
          if (kind === "file") {
            budget.startEntry();
            budget.addEntrySize(entry.size);
          }
          if (kind === "file" || kind === "directory") {
            plan.push({
              index: entry.index,
              path: relPath,
              kind,
              size: entry.size,
              mode: resolveArchiveEntryMode({
                kind,
                archivedMode: entry.mode,
                policy: params.entryModes,
              }),
            });
          }
        }

        const directory = await fs.open(
          stagingDir,
          fsConstants.O_RDONLY |
            (typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0),
        );
        try {
          params.deadline.check();
          await params.binding.extractArchiveNative(
            stagedArchive.path,
            params.kind,
            directory.fd,
            plan,
            limits.maxMetaEntryBytes,
            params.deadline.signal,
          );
        } finally {
          await directory.close().catch(() => undefined);
        }
        params.deadline.check();
        await mergeExtractedTreeIntoDestination({
          sourceDir: stagingDir,
          destinationDir: params.destDir,
          destinationRealDir,
        });
      },
    });
  } finally {
    await stagedArchive.cleanup();
  }
}
