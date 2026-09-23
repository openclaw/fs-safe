import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { normalizeMaxBytes } from "./byte-budget.js";
import type { ContainmentGuarantee } from "./containment.js";
import { readFileHandleBounded } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";

export type ReadResult = {
  buffer: Buffer;
  containment: ContainmentGuarantee;
  realPath: string;
  stat: Stats;
};

type OpenedFile = {
  handle: FileHandle;
  containment: ContainmentGuarantee;
  realPath: string;
  stat: Stats;
};

export async function readOpenedFileSafely(params: {
  opened: OpenedFile;
  maxBytes?: number;
  verifyUnchanged?: boolean;
}): Promise<ReadResult> {
  const maxBytes = normalizeMaxBytes(params.maxBytes);
  const before = params.opened.stat;
  if (params.verifyUnchanged && (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0)) {
    throw new FsSafeError("read-changed", "file metadata cannot verify an unchanged read");
  }
  if (maxBytes !== undefined && before.size > maxBytes) {
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${maxBytes} bytes (got ${before.size})`,
    );
  }
  const buffer =
    maxBytes === undefined
      ? await params.opened.handle.readFile()
      : await readFileHandleBounded(params.opened.handle, maxBytes);
  const stat = params.verifyUnchanged ? await params.opened.handle.stat() : before;
  if (params.verifyUnchanged && (
    !stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino ||
    stat.size !== before.size || stat.mtimeMs !== before.mtimeMs ||
    stat.ctimeMs !== before.ctimeMs || stat.nlink !== before.nlink || buffer.length !== stat.size
  )) {
    throw new FsSafeError("read-changed", "file changed while reading");
  }
  return {
    buffer,
    containment: params.opened.containment,
    realPath: params.opened.realPath,
    stat,
  };
}
