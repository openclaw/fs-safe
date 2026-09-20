import syncFs, { type BigIntStats, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { readBoundedSync } from "./bounded-read.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { FsSafeError } from "./errors.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { hasErrorCode } from "./file-cleanup.js";

type AsyncSourceFileSystem = Pick<typeof import("node:fs/promises"), "lstat" | "open">;
type SyncSourceFileSystem = Pick<
  typeof syncFs,
  "closeSync" | "fstatSync" | "lstatSync" | "openSync" | "readSync"
>;

const OPEN_READ_FLAGS = resolveReadOpenFlags();

function assertSourcePreview(source: Stats, src: string): void {
  if (source.isSymbolicLink()) {
    throw new FsSafeError("symlink", `Refusing copy fallback from non-file source: ${src}`);
  }
  if (!source.isFile()) {
    throw new FsSafeError("not-file", `Refusing copy fallback from non-file source: ${src}`);
  }
  if (source.nlink !== 1) {
    throw new FsSafeError("hardlink", `Hardlinked copy fallback source not allowed: ${src}`);
  }
}

function assertOpenedSource(opened: BigIntStats, current: BigIntStats, src: string): void {
  if (!opened.isFile() || current.isSymbolicLink()) {
    throw new FsSafeError("path-mismatch", `Copy fallback source changed while opening: ${src}`);
  }
  if (opened.nlink !== 1n) {
    throw new FsSafeError("hardlink", `Hardlinked copy fallback source not allowed: ${src}`);
  }
}

function sourceSymlinkError(src: string, cause: unknown): FsSafeError {
  return new FsSafeError("symlink", `Refusing copy fallback from non-file source: ${src}`, {
    cause,
  });
}

async function openSource(fsModule: AsyncSourceFileSystem, src: string): Promise<FileHandle> {
  try {
    return await fsModule.open(src, OPEN_READ_FLAGS);
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) {
      throw sourceSymlinkError(src, error);
    }
    throw error;
  }
}

function openSourceSync(fsModule: SyncSourceFileSystem, src: string): number {
  try {
    return fsModule.openSync(src, OPEN_READ_FLAGS);
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) {
      throw sourceSymlinkError(src, error);
    }
    throw error;
  }
}

function readAllSync(fsModule: SyncSourceFileSystem, fd: number, size: number): Buffer {
  let position = 0;
  return readBoundedSync(Infinity, (buffer, length) => {
    const bytesRead = fsModule.readSync(fd, buffer, 0, length, position);
    position += bytesRead;
    return bytesRead;
  }, { initialSize: Number.isSafeInteger(size) && size >= 0 ? size : undefined });
}

export async function readOwnedCopySource(params: {
  fsModule: AsyncSourceFileSystem;
  src: string;
  expectedIdentity?: BigIntStats;
}): Promise<{ replacement: Buffer; mode: number }> {
  assertSourcePreview(params.fsModule === fs
    ? syncFs.lstatSync(params.src) : await params.fsModule.lstat(params.src), params.src);
  const handle = await openSource(params.fsModule, params.src);
  try {
    const opened = await inspectFileIdentity(
      () => params.fsModule === fs
        ? syncFs.fstatSync(handle.fd, { bigint: true }) : handle.stat({ bigint: true }),
      params.expectedIdentity,
    );
    const current = await inspectFileIdentity(
      () => params.fsModule === fs
        ? syncFs.lstatSync(params.src, { bigint: true }) : params.fsModule.lstat(params.src, { bigint: true }),
      opened,
    );
    assertOpenedSource(opened, current, params.src);
    return { replacement: await handle.readFile(), mode: Number(opened.mode) };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function readOwnedCopySourceSync(params: {
  fsModule: SyncSourceFileSystem;
  src: string;
  expectedIdentity?: BigIntStats;
}): { replacement: Buffer; mode: number } {
  assertSourcePreview(params.fsModule.lstatSync(params.src), params.src);
  const fd = openSourceSync(params.fsModule, params.src);
  try {
    const opened = inspectFileIdentitySync(
      () => params.fsModule.fstatSync(fd, { bigint: true }),
      params.expectedIdentity,
    );
    const current = inspectFileIdentitySync(
      () => params.fsModule.lstatSync(params.src, { bigint: true }),
      opened,
    );
    assertOpenedSource(opened, current, params.src);
    return { replacement: readAllSync(params.fsModule, fd, Number(opened.size)), mode: Number(opened.mode) };
  } finally {
    try {
      params.fsModule.closeSync(fd);
    } catch {
      // Best-effort close after reading a copy-fallback source.
    }
  }
}
