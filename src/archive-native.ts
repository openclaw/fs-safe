import { classifyArchiveParserError } from "./archive-parser-errors.js";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import {
  ArchiveFormatError,
  isArchiveFormatErrorMessage,
} from "./archive-errors.js";
import { validateArchiveEntryPath } from "./archive-entry.js";
import { createArchiveEntryPlanner, type ArchivePlanEntry } from "./archive-plan.js";
import type { ArchiveKind } from "./archive-kind.js";
import {
  assertArchiveEntryCountWithinLimit,
  type TarMeterLimits,
} from "./archive-limits.js";
import type { StagedArchiveExtractOptions } from "./archive-options.js";
import { prepareArchiveDestinationGuard } from "./archive-staging.js";
import { withStagedArchivePublication } from "./archive-merge.js";
import type { ZipDirectoryEntry } from "./archive-zip-directory.js";
import type { NativeBinding } from "./native.js";
import { admitZipFile } from "./archive-zip-admission.js";
import { validateNativeZipManifest } from "./archive-zip-manifest.js";

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

export async function extractNativeArchive(params: StagedArchiveExtractOptions & {
  binding: NativeBinding;
  kind: ArchiveKind;
  tarLimits: TarMeterLimits;
}): Promise<void> {
  const { archivePath, limits, tarLimits, deadline } = params;
  const zipEntries: ZipDirectoryEntry[] = [];
  if (params.kind === "zip") {
    await admitZipFile(archivePath, limits, deadline, (entry) => { zipEntries.push(entry); });
  }
  const destinationGuard = await prepareArchiveDestinationGuard(params.destDir);
  await withStagedArchivePublication({ ...params, destinationGuard }, async (stagingDir) => {
    deadline.check();
    // N-API retains completed task state on its signal; each pass needs its own.
    const manifest = await params.binding
      .inspectArchiveNative(
        archivePath,
        params.kind,
        tarLimits,
        AbortSignal.any([deadline.signal]),
      )
      .catch(throwMappedNativeArchiveError);
    deadline.check();
    assertArchiveEntryCountWithinLimit(manifest.length, limits);
    if (params.kind === "zip") {
      validateNativeZipManifest(manifest, zipEntries);
    }
    // Recheck the native manifest before any caller callback observes an entry.
    if (params.kind !== "zip") {
      for (const entry of manifest) validateArchiveEntryPath(entry.path);
    }
    const planEntry = createArchiveEntryPlanner({ ...params, rootDir: stagingDir }, params.kind);
    const plan: Array<ArchivePlanEntry & { index: number }> = [];
    for (const entry of manifest) {
      deadline.check();
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
      deadline.check();
      await params.binding.extractArchiveNative(
        archivePath,
        params.kind,
        directory.fd,
        plan.map((entry) => ({ ...entry, mode: entry.kind === "directory" ? 0o700 : 0o600 })),
        tarLimits,
        AbortSignal.any([deadline.signal]),
      ).catch(throwMappedNativeArchiveError);
    } finally {
      await directory.close().catch(() => undefined);
    }
    return plan;
  });
}
