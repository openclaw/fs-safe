import fsSync, { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtractionDeadline } from "./archive-deadline.js";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  type ResolvedArchiveExtractLimits,
} from "./archive-limits.js";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { tempFile } from "./temp-target.js";
import { writeAllToFile } from "./write-file-handle.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

export type StagedArchiveFile = { path: string; cleanup: () => Promise<void> };

async function closeFileHandle(handle: FileHandle | undefined): Promise<void> {
  if (handle) await handle.close().catch(() => undefined);
}

const createArchiveWriteError = () => new Error("archive staging write made no progress");

export async function stageArchiveFileForExtraction(params: {
  archivePath: string;
  limits: ResolvedArchiveExtractLimits;
  deadline: ExtractionDeadline;
}): Promise<StagedArchiveFile> {
  params.deadline.check();
  const archivePath = params.archivePath;
  assertNoWindowsPathAlias(archivePath);
  const sourcePath = path.resolve(archivePath);
  assertNoWindowsPathAlias(sourcePath);
  const initialStat = await inspectFileIdentity(async () => {
    const stat = fsSync.lstatSync(sourcePath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`archive is not a regular file: ${archivePath}`);
    }
    return stat;
  });
  if (initialStat.size > params.limits.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }
  const handle = await fs.open(sourcePath, resolveReadOpenFlags());
  let staged: StagedArchiveFile | undefined;
  let output: FileHandle | undefined;
  try {
    staged = await tempFile({
      prefix: "fs-safe-archive-input",
      fileName: path.basename(sourcePath),
    });
    const opened = await inspectFileIdentity(async () => {
      const stat = fsSync.fstatSync(handle.fd, { bigint: true });
      if (!stat.isFile()) throw new Error("archive changed during validation");
      return stat;
    }, initialStat);
    await inspectFileIdentity(async () => {
      const stat = fsSync.lstatSync(sourcePath, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("archive changed during validation");
      return stat;
    }, opened);

    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (process.platform !== "win32" && "O_NOFOLLOW" in fsConstants
        ? fsConstants.O_NOFOLLOW
        : 0);
    output = await fs.open(staged.path, flags, 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(
      512 * 1024, Math.max(64 * 1024, Number(opened.size)), params.limits.maxArchiveBytes + 1,
    ));
    const writeOptions = {
      assertBeforeMutation: () => params.deadline.check(),
      createNoProgressError: createArchiveWriteError,
    };
    let written = 0;
    while (true) {
      params.deadline.check();
      const length = Math.min(buffer.length, params.limits.maxArchiveBytes - written + 1);
      const { bytesRead } = await handle.read(buffer, 0, length, null);
      params.deadline.check();
      if (bytesRead === 0) break;
      written += bytesRead;
      if (written > params.limits.maxArchiveBytes) {
        throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
      }
      await writeAllToFile(output, buffer, writeOptions, bytesRead);
    }
    await output.close();
    output = undefined;
    return staged;
  } catch (error) {
    await closeFileHandle(output);
    await staged?.cleanup().catch(() => undefined);
    if (error instanceof FsSafeError && error.code === "path-mismatch") {
      throw new FsSafeError("path-mismatch", "archive changed during validation", { cause: error });
    }
    throw error;
  } finally {
    await closeFileHandle(handle);
  }
}
