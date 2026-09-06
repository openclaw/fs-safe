import syncFs, { type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";

type AsyncSourceFileSystem = Pick<typeof import("node:fs/promises"), "lstat" | "open">;
type SyncSourceFileSystem = Pick<
  typeof syncFs,
  "closeSync" | "fstatSync" | "lstatSync" | "openSync" | "readSync"
>;

const OPEN_READ_FLAGS = resolveReadOpenFlags();
const READ_CHUNK_BYTES = 64 * 1024;

function assertSourcePreview(source: import("node:fs").Stats, src: string): void {
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

function sourceSymlinkError(src: string, cause: unknown): FsSafeError {
  return new FsSafeError("symlink", `Refusing copy fallback from non-file source: ${src}`, {
    cause,
  });
}

async function openSource(fsModule: AsyncSourceFileSystem, src: string): Promise<FileHandle> {
  try {
    return await fsModule.open(src, OPEN_READ_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw sourceSymlinkError(src, error);
    }
    throw error;
  }
}

function openSourceSync(fsModule: SyncSourceFileSystem, src: string): number {
  try {
    return fsModule.openSync(src, OPEN_READ_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw sourceSymlinkError(src, error);
    }
    throw error;
  }
}

function readAllSync(fsModule: SyncSourceFileSystem, fd: number): Buffer {
  const chunks: Buffer[] = [];
  let position = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const bytesRead = fsModule.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, position);
}

export async function readOwnedCopySource(params: {
  fsModule: AsyncSourceFileSystem;
  src: string;
  expectedIdentity?: BigIntStats;
}): Promise<{ replacement: Buffer; mode: number }> {
  assertSourcePreview(await params.fsModule.lstat(params.src), params.src);
  const handle = await openSource(params.fsModule, params.src);
  try {
    if (params.expectedIdentity) {
      const exact = await inspectFileIdentity(
        () => handle.stat({ bigint: true }),
        params.expectedIdentity,
      );
      await inspectFileIdentity(
        () => params.fsModule.lstat(params.src, { bigint: true }),
        exact,
      );
    }
    const opened = await handle.stat();
    const current = await params.fsModule.lstat(params.src);
    if (!opened.isFile() || current.isSymbolicLink() || !sameFileIdentity(opened, current)) {
      throw new FsSafeError("path-mismatch", `Copy fallback source changed while opening: ${params.src}`);
    }
    if (opened.nlink !== 1) {
      throw new FsSafeError("hardlink", `Hardlinked copy fallback source not allowed: ${params.src}`);
    }
    return { replacement: await handle.readFile(), mode: opened.mode };
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
    if (params.expectedIdentity) {
      const exact = inspectFileIdentitySync(
        () => params.fsModule.fstatSync(fd, { bigint: true }),
        params.expectedIdentity,
      );
      inspectFileIdentitySync(
        () => params.fsModule.lstatSync(params.src, { bigint: true }),
        exact,
      );
    }
    const opened = params.fsModule.fstatSync(fd);
    const current = params.fsModule.lstatSync(params.src);
    if (!opened.isFile() || current.isSymbolicLink() || !sameFileIdentity(opened, current)) {
      throw new FsSafeError("path-mismatch", `Copy fallback source changed while opening: ${params.src}`);
    }
    if (opened.nlink !== 1) {
      throw new FsSafeError("hardlink", `Hardlinked copy fallback source not allowed: ${params.src}`);
    }
    return { replacement: readAllSync(params.fsModule, fd), mode: opened.mode };
  } finally {
    try {
      params.fsModule.closeSync(fd);
    } catch {
      // Best-effort close after reading a copy-fallback source.
    }
  }
}
