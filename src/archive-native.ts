import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import {
  ArchiveFormatError,
  ArchiveSecurityError,
  isArchiveFormatErrorMessage,
  isArchiveTarPathErrorMessage,
} from "./archive-errors.js";
import { formatErrorDetail } from "./error-detail.js";
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
  type ResolvedArchiveExtractLimits,
  type TarMeterLimits,
} from "./archive-limits.js";
import type { ExtractArchiveOptions } from "./archive-options.js";
import { resolveArchiveEntryMode, shouldExtractArchiveEntry } from "./archive-policy.js";
import {
  prepareArchiveDestinationDir,
  withStagedArchiveDestination,
} from "./archive-staging.js";
import { mergePlannedArchiveIntoDestination } from "./archive-merge.js";
import type { ZipDirectoryEntry } from "./archive-zip-directory.js";
import type { NativeBinding } from "./native.js";
import { admitZipFile } from "./archive-zip-admission.js";

function policyKind(kind: string): "file" | "directory" | "symlink" | "other" {
  if (kind === "file" || kind === "directory") return kind;
  if (kind === "symlink" || kind === "hardlink") return "symlink";
  return "other";
}

function throwMappedNativeError(error: unknown): never {
  if (error instanceof Error) {
    if (isArchiveTarPathErrorMessage(error.message)) {
      throw new ArchiveSecurityError("entry-path", error.message, { cause: error });
    }
    for (const code of Object.values(ARCHIVE_LIMIT_ERROR_CODE)) {
      if (error.message.includes(code)) throw new ArchiveLimitError(code);
    }
    if (isArchiveFormatErrorMessage(error.message)) {
      throw new ArchiveFormatError(error.message, { cause: error });
    }
    if ((error as Error & { code?: unknown }).code === "InvalidArg") {
      throw new ArchiveFormatError(`invalid archive: ${error.message}`, { cause: error });
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
  limits: ResolvedArchiveExtractLimits;
  tarLimits: TarMeterLimits;
  deadline: ExtractionDeadline;
  entryModes?: ExtractArchiveOptions["entryModes"];
  entryFilter?: ExtractArchiveOptions["entryFilter"];
  onFiltered?: ExtractArchiveOptions["onFiltered"];
}): Promise<void> {
  const { limits, tarLimits } = params;
  const stagedArchive = await stageArchiveFileForExtraction({
    archivePath: params.archivePath,
    limits,
    deadline: params.deadline,
  });
  try {
    const zipEntries: ZipDirectoryEntry[] = [];
    const physicalCount = params.kind === "zip"
      ? await admitZipFile(stagedArchive.path, limits, params.deadline, (entry) => { zipEntries.push(entry); })
      : undefined;
    const destinationRealDir = await prepareArchiveDestinationDir(params.destDir);
    await withStagedArchiveDestination({
      destinationRealDir,
      run: async (stagingDir) => {
        params.deadline.check();
        const manifest = await params.binding
          .inspectArchiveNative(
            stagedArchive.path,
            params.kind,
            tarLimits,
            params.deadline.signal,
          )
          .catch(throwMappedNativeError);
        params.deadline.check();
        assertArchiveEntryCountWithinLimit(manifest.length, limits);
        if (physicalCount !== undefined && manifest.length !== physicalCount) {
          throw new ArchiveSecurityError("entry-path", "zip decoder collapsed entry names");
        }
        if (params.kind === "zip") {
          for (const [ordinal, entry] of manifest.entries()) {
            const physical = zipEntries[ordinal];
            // Native ZIP indices are physical central-directory ordinals. Legacy
            // filename decoding remains native-selected; compare names when known.
            if (!physical || physical.index !== ordinal || entry.index !== ordinal ||
                entry.size !== physical.size ||
                (physical.path !== undefined && stripArchivePath(entry.path, 0) !== stripArchivePath(physical.path, 0)) ||
                (physical.creatorSystem === 3 && entry.mode !== physical.externalAttributes >>> 16)) {
              throw new ArchiveFormatError("ZIP decoder disagrees with admitted directory metadata");
            }
          }
        }
        // Recheck the native manifest at the shared policy boundary before
        // any caller callback observes an entry.
        if (params.kind !== "zip") {
          for (const entry of manifest) validateArchiveEntryPath(entry.path);
        }
        const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
        const budget = createByteBudgetTracker(limits);
        const trackOutputPath = createArchiveOutputPathTracker();
        const plan: Array<{
          index: number;
          path: string;
          kind: "file" | "directory";
          size: number;
          mode: number;
        }> = [];

        for (const entry of manifest) {
          params.deadline.check();
          validateArchiveEntryPath(entry.path);
          const canonicalPath = stripArchivePath(entry.path, 0);
          if (!canonicalPath) continue;
          const relPath = stripArchivePath(canonicalPath, strip);
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
              entry: { path: canonicalPath, kind, size: entry.size },
            })
          ) {
            continue;
          }
          if (entry.kind === "sparse") {
            throw new ArchiveFormatError(
              `GNU sparse archive entry is not supported: ${formatErrorDetail(entry.path)}`,
            );
          }
          if (kind === "symlink" || entry.kind === "blocked") {
            const label = params.kind === "zip" ? "zip" : "tar";
            throw new ArchiveSecurityError(
              "entry-link",
              `${label} entry is a link: ${formatErrorDetail(entry.path)}`,
            );
          }
          if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
            throw new ArchiveLimitError(
              ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT,
            );
          }
          // GNUDumpDir can carry a body; charge accepted TAR sizes as JS does.
          if (kind === "file" || (kind === "directory" && params.kind !== "zip")) {
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
                archivedMode: params.kind === "zip"
                  ? zipEntries[entry.index]!.creatorSystem === 3
                    ? zipEntries[entry.index]!.externalAttributes >>> 16
                    : undefined
                  : entry.mode,
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
            plan.map((entry) => ({ ...entry, mode: entry.kind === "directory" ? 0o700 : 0o600 })),
            tarLimits,
            params.deadline.signal,
          ).catch(throwMappedNativeError);
        } finally {
          await directory.close().catch(() => undefined);
        }
        params.deadline.check();
        await mergePlannedArchiveIntoDestination({
          entries: plan,
          sourceDir: stagingDir,
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
