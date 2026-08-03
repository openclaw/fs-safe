import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtractionDeadline } from "./archive-deadline.js";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  type ResolvedArchiveExtractLimits,
} from "./archive-limits.js";
import { sameFileIdentity } from "./file-identity.js";
import { tempFile } from "./temp-target.js";

export type StagedArchiveFile = { path: string; cleanup: () => Promise<void> };

async function closeFileHandle(handle: FileHandle | undefined): Promise<void> {
  if (handle) await handle.close().catch(() => undefined);
}

async function writeFileHandleFully(params: {
  handle: FileHandle;
  buffer: Buffer;
  bytes: number;
  deadline: ExtractionDeadline;
}): Promise<void> {
  let offset = 0;
  while (offset < params.bytes) {
    params.deadline.check();
    const { bytesWritten } = await params.handle.write(
      params.buffer,
      offset,
      params.bytes - offset,
    );
    if (bytesWritten <= 0) {
      throw new Error("archive staging write made no progress");
    }
    offset += bytesWritten;
  }
}

export async function stageArchiveFileForExtraction(params: {
  archivePath: string;
  limits: ResolvedArchiveExtractLimits;
  deadline: ExtractionDeadline;
}): Promise<StagedArchiveFile> {
  params.deadline.check();
  const sourcePath = path.resolve(params.archivePath);
  const initialStat = await fs.lstat(sourcePath);
  if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
    throw new Error(`archive is not a regular file: ${params.archivePath}`);
  }
  if (initialStat.size > params.limits.maxArchiveBytes) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
  }
  const noFollow =
    process.platform !== "win32" && "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(sourcePath, fsConstants.O_RDONLY | noFollow);
  let staged: StagedArchiveFile | undefined;
  let output: FileHandle | undefined;
  try {
    staged = await tempFile({
      prefix: "fs-safe-archive-input",
      fileName: path.basename(sourcePath),
    });
    const openedStat = await handle.stat();
    const pathStat = await fs.lstat(sourcePath);
    if (
      !openedStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      !sameFileIdentity(initialStat, openedStat) ||
      !sameFileIdentity(pathStat, openedStat)
    ) {
      throw new Error("archive changed during validation");
    }

    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (process.platform !== "win32" && "O_NOFOLLOW" in fsConstants
        ? fsConstants.O_NOFOLLOW
        : 0);
    output = await fs.open(staged.path, flags, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let written = 0;
    while (true) {
      params.deadline.check();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      written += bytesRead;
      if (written > params.limits.maxArchiveBytes) {
        throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT);
      }
      await writeFileHandleFully({ handle: output, buffer, bytes: bytesRead, deadline: params.deadline });
    }
    await output.close();
    output = undefined;
    return staged;
  } catch (error) {
    await closeFileHandle(output);
    await staged?.cleanup().catch(() => undefined);
    throw error;
  } finally {
    await closeFileHandle(handle);
  }
}
