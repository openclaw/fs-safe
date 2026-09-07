import { classifyArchiveParserError } from "./archive-parser-errors.js";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import {
  ArchiveFormatError,
  ArchiveSecurityError,
  isArchiveFormatErrorMessage,
} from "./archive-errors.js";
import { stripArchivePath, validateArchiveEntryPath } from "./archive-entry.js";
import { createArchiveEntryPlanner, type ArchivePlanEntry } from "./archive-plan.js";
import type { ExtractionDeadline } from "./archive-deadline.js";
import { stageArchiveFileForExtraction } from "./archive-input.js";
import type { ArchiveKind } from "./archive-kind.js";
import {
  assertArchiveEntryCountWithinLimit,
  type ResolvedArchiveExtractLimits,
  type TarMeterLimits,
} from "./archive-limits.js";
import type { ExtractArchiveOptions } from "./archive-options.js";
import {
  prepareArchiveDestinationDir,
  withStagedArchiveDestination,
} from "./archive-staging.js";
import { mergePlannedArchiveIntoDestination } from "./archive-merge.js";
import type { ZipDirectoryEntry } from "./archive-zip-directory.js";
import type { NativeBinding } from "./native.js";
import { admitZipFile } from "./archive-zip-admission.js";

export function throwMappedNativeArchiveError(error: unknown): never {
  if (error instanceof Error) {
    const mapped = classifyArchiveParserError(error.message, { cause: error });
    if (mapped) throw mapped;
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
          .catch(throwMappedNativeArchiveError);
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
        const planEntry = createArchiveEntryPlanner({ ...params, rootDir: stagingDir });
        const plan: Array<ArchivePlanEntry & { index: number }> = [];
        for (const entry of manifest) {
          params.deadline.check();
          const mode = params.kind === "zip"
            ? zipEntries[entry.index]!.creatorSystem === 3
              ? zipEntries[entry.index]!.externalAttributes >>> 16
              : undefined
            : entry.mode;
          const accepted = planEntry({ ...entry, mode });
          if (accepted) plan.push({ ...accepted, index: entry.index });
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
          ).catch(throwMappedNativeArchiveError);
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
