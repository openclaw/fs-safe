import {
  createTarEntryPlanner,
  createArchiveEntrySelector,
  resolveArchiveFilteredEntryPolicy,
  type ExtractArchiveOptions,
  type StagedArchiveExtractOptions,
  createArchiveEntryPlanner,
  type ArchivePlanEntry,
} from "./archive-plan.js";
import { inspectTar, replayTar } from "./archive-tar-stream.js";
import type { AdmittedTarMember } from "./archive-tar-wasm.js";
import { runPinnedWriteHelper } from "./pinned-write.js";
import { constants as fsConstants } from "node:fs";
import fs, {
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createPipelineTimeoutError,
  waitForDeadline,
  withExtractionDeadline,
  type ExtractionDeadline,
} from "./archive-deadline.js";
import {
  assertArchiveEntryCountWithinLimit,
  createByteBudgetTracker,
  createExtractBudgetTransform,
  resolveExtractLimits,
  resolveTarMeterLimits,
  type TarMeterLimits,
} from "./archive-limits.js";
import { resolveArchiveKind, type ArchiveKind } from "./archive-kind.js";
import {
  prepareArchiveDestinationGuard,
  preparePrivateArchiveOutputPath,
} from "./archive-staging.js";
import { withStagedArchivePublication, type ArchivePublicationEntry } from "./archive-merge.js";
import { loadZipArchiveWithPreflight } from "./archive-zip-preflight.js";
import { admittedZipEntries } from "./archive-zip-loader.js";
import {
  zipEntryKind,
  zipEntryDeclaredSize,
  zipEntryMode,
  type ZipEntry,
} from "./archive-zip-entry.js";
import {
  createZipIntegrityTransform,
  normalizeZipIntegrityError,
} from "./archive-zip-integrity.js";
import {
  ArchiveSecurityError,
  ArchiveFormatError,
  isArchiveFormatErrorMessage,
} from "./archive-errors.js";
import { stageArchiveFileForExtraction } from "./archive-input.js";
import {
  getNativeBinding,
  type NativeBinding,
} from "./native.js";
import { writeSiblingTempFile } from "./sibling-temp.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { classifyArchiveParserError } from "./archive-parser-errors.js";
import { validateArchiveEntryPath } from "./archive-entry.js";
import type { ZipDirectoryEntry } from "./archive-zip-directory.js";
import { admitZipFile } from "./archive-zip-admission.js";
import { validateNativeZipManifest } from "./archive-zip-manifest.js";

export type { ArchiveLogger, ExtractArchiveOptions } from "./archive-plan.js";
export type {
  ArchiveEntryFilter,
  ArchiveEntryKind,
  ArchiveEntryModePolicy,
  ArchiveFilteredEntryPolicy,
} from "./archive-plan.js";
export {
  isWindowsDrivePath,
  normalizeArchiveEntryPath,
  resolveArchiveOutputPath,
  stripArchivePath,
  validateArchiveEntryPath,
} from "./archive-entry.js";
export { resolveArchiveKind, resolvePackedRootDir, type ArchiveKind } from "./archive-kind.js";
export { readArchiveEntry } from "./archive-read.js";

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
export { ArchiveSecurityError, type ArchiveSecurityErrorCode } from "./archive-errors.js";
export {
  createArchiveSymlinkTraversalError,
  prepareArchiveDestinationDir,
  prepareArchiveOutputPath,
  withStagedArchiveDestination,
} from "./archive-staging.js";
export { mergeExtractedTreeIntoDestination } from "./archive-merge.js";
export { createTarEntryPreflightChecker, type TarEntryInfo } from "./archive-plan.js";
export { loadZipArchiveWithPreflight } from "./archive-zip-preflight.js";
export { readZipCentralDirectoryEntryCount } from "./archive-zip-count.js";
export type { ZipArchiveWithFiles } from "./archive-zip-loader.js";
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
      syncTempFile: false,
      syncParentDir: false,
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
          await tempHandle.close();
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

async function extractZip(params: StagedArchiveExtractOptions): Promise<void> {
  const { limits, deadline } = params;
  const destinationGuard = await prepareArchiveDestinationGuard(params.destDir);
  deadline.check();
  const buffer = await fs.readFile(params.archivePath, { signal: deadline.signal });
  deadline.check();
  const zip = await waitForDeadline(loadZipArchiveWithPreflight(buffer, limits), deadline);
  deadline.check();
  const entries = admittedZipEntries(zip);
  assertArchiveEntryCountWithinLimit(entries.length, limits);
  const budget = createByteBudgetTracker(limits);

  await withStagedArchivePublication({ ...params, destinationGuard }, async (stagingDir) => {
    const { select } = createArchiveEntrySelector({ ...params, rootDir: stagingDir });
    const acceptedEntries: ArchivePublicationEntry[] = [];
    for (const entry of entries) {
      deadline.check();
      const entryKind = zipEntryKind(entry);
      const relPath = select({ path: entry.name, kind: entryKind, size: zipEntryDeclaredSize(entry) });
      if (relPath === null) continue;
      if (entryKind === "symlink") {
        throw new ArchiveSecurityError("entry-link", `zip entry is a link: ${entry.name}`);
      }
      if (entryKind === "other") continue;
      const mode = zipEntryMode(entry, params.entryModes);
      acceptedEntries.push({ path: relPath, kind: entry.dir ? "directory" : "file", mode });
      const outPath = path.join(stagingDir, relPath);
      await preparePrivateArchiveOutputPath({
        destinationDir: stagingDir,
        destinationRealDir: stagingDir,
        relPath,
        outPath,
        originalPath: entry.name,
        isDirectory: entry.dir,
        deadline,
      });
      if (!entry.dir) {
        await writeZipFileEntry({ entry, outPath, budget, deadline });
      }
    }
    return acceptedEntries;
  });
}

export async function extractArchive(params: ExtractArchiveOptions): Promise<void> {
  const archivePath = params.archivePath;
  const destDir = params.destDir;
  const { entryUmask = 0 } = params;
  if (!Number.isInteger(entryUmask) || entryUmask < 0 || entryUmask > 0o777) {
    throw new RangeError("archive entryUmask must be an integer between 0 and 0o777");
  }
  const onFiltered = resolveArchiveFilteredEntryPolicy(params.onFiltered);
  const kind = params.kind ?? resolveArchiveKind(archivePath);
  if (!kind) {
    throw new Error(`unsupported archive: ${archivePath}`);
  }

  const label = kind === "zip" ? "extract zip" : "extract tar";
  const limits = resolveExtractLimits(params.limits);
  const tarLimits = resolveTarMeterLimits(limits);
  const native = getNativeBinding();
  assertNoWindowsPathAlias(archivePath, "filesystem", "archive source uses a Windows filesystem namespace alias");
  assertNoWindowsPathAlias(destDir, "filesystem", "archive destination uses a Windows filesystem namespace alias");
  // Read the declared public fields before private adapters copy options: class
  // getters and inherited policy must survive identically on every backend.
  const options = {
    archivePath, destDir,
    durable: params.durable,
    stripComponents: params.stripComponents, limits,
    entryModes: params.entryModes, entryUmask, entryFilter: params.entryFilter, onFiltered,
  };
  await withExtractionDeadline(params.timeoutMs, label, async (deadline) => {
    const stagedArchive = await stageArchiveFileForExtraction({ archivePath, limits, deadline });
    try {
      deadline.check();
      const stagedOptions = { ...options, archivePath: stagedArchive.path, deadline };
      if (native) await extractNativeArchive({ ...stagedOptions, binding: native, kind, tarLimits });
      else if (kind === "zip") await extractZip(stagedOptions);
      else await extractWasmTar({ ...stagedOptions, kind, tarLimits });
    } finally {
      await stagedArchive.cleanup();
    }
  });
}

async function extractWasmTar(params: StagedArchiveExtractOptions & {
  kind: Exclude<ArchiveKind, "zip">;
  tarLimits: TarMeterLimits;
}): Promise<void> {
  const { deadline, tarLimits } = params;
  const manifest: AdmittedTarMember[] = [];
  await inspectTar({ archivePath: params.archivePath, kind: params.kind, limits: tarLimits, signal: deadline.signal,
    onMember: (entry) => { manifest.push(entry); } });
  deadline.check();
  const destinationGuard = await prepareArchiveDestinationGuard(params.destDir);
  await withStagedArchivePublication({ ...params, destinationGuard }, async (stagingDir) => {
    const planEntry = createTarEntryPlanner({ ...params, rootDir: destinationGuard.realPath });
    const accepted = manifest.flatMap((entry) => {
      deadline.check();
      const planned = planEntry(entry);
      return planned ? [{ ...entry, ...planned }] : [];
    });
    await replayTar({ archivePath: params.archivePath, kind: params.kind, limits: tarLimits, signal: deadline.signal, members: accepted,
      async consume(member, payload) {
        deadline.check();
        await preparePrivateArchiveOutputPath({ destinationDir: stagingDir, destinationRealDir: stagingDir,
          relPath: member.path, outPath: path.join(stagingDir, member.path), originalPath: member.path,
          isDirectory: member.kind === "directory", deadline });
        if (member.kind === "file") {
          await runPinnedWriteHelper({ rootPath: stagingDir, relativeParentPath: path.posix.dirname(member.path),
            basename: path.posix.basename(member.path), mkdir: false, mode: 0o600, overwrite: false,
            sync: false,
            maxBytes: member.size, input: { kind: "stream", stream: Readable.from(payload) } });
        }
        deadline.check();
      },
    });
    return accepted;
  });
}
function throwMappedNativeArchiveError(error: unknown): never {
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

async function extractNativeArchive(params: StagedArchiveExtractOptions & {
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
export type InspectTarArchiveOptions = Pick<ExtractArchiveOptions,
  "archivePath" | "timeoutMs" | "limits" | "entryFilter" | "onFiltered">;
export type InspectedTarEntry = Readonly<Pick<ArchivePlanEntry, "path" | "kind" | "size">>;

/** Complete TAR/gzip admission and zero-strip extraction policy, without output writes. */
export async function inspectTarArchive(params: InspectTarArchiveOptions): Promise<readonly InspectedTarEntry[]> {
  const archivePath = params.archivePath;
  const onFiltered = resolveArchiveFilteredEntryPolicy(params.onFiltered);
  const limits = resolveExtractLimits(params.limits);
  const tarLimits = resolveTarMeterLimits(limits);
  const native = getNativeBinding();
  assertNoWindowsPathAlias(archivePath, "filesystem", "archive source uses a Windows filesystem namespace alias");
  return await withExtractionDeadline(params.timeoutMs, "inspect tar", async (deadline) => {
    const staged = await stageArchiveFileForExtraction({ archivePath, limits, deadline });
    try {
      // Staging closes descriptors asynchronously; expiry there must not start a decoder.
      deadline.check();
      const entries: InspectedTarEntry[] = [];
      const append = (entry: ArchivePlanEntry | null) => {
        if (entry) entries.push(Object.freeze({ path: entry.path, kind: entry.kind, size: entry.size }));
      };
      const policy = { limits, entryFilter: params.entryFilter, onFiltered };
      if (native) {
        const manifest = await native.inspectArchiveNative(staged.path, "tar", tarLimits, deadline.signal)
          .catch(throwMappedNativeArchiveError);
        deadline.check();
        // Match extraction's whole-manifest validation before caller policy runs.
        for (const entry of manifest) validateArchiveEntryPath(entry.path);
        const planEntry = createArchiveEntryPlanner(policy, "tar");
        for (const entry of manifest) {
          deadline.check();
          append(planEntry(entry));
        }
      } else {
        const manifest: AdmittedTarMember[] = [];
        await inspectTar({ archivePath: staged.path, limits: tarLimits, signal: deadline.signal,
          onMember: (entry) => { manifest.push(entry); } });
        const planEntry = createTarEntryPlanner(policy);
        for (const entry of manifest) {
          deadline.check();
          append(planEntry(entry));
        }
      }
      deadline.check();
      // This is bounded evidence about the staged bytes, not a reusable write plan.
      return Object.freeze(entries);
    } finally {
      await staged.cleanup();
    }
  });
}
