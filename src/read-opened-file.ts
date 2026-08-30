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
}): Promise<ReadResult> {
  const maxBytes = normalizeMaxBytes(params.maxBytes);
  if (maxBytes !== undefined && params.opened.stat.size > maxBytes) {
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${maxBytes} bytes (got ${params.opened.stat.size})`,
    );
  }
  const buffer =
    maxBytes === undefined
      ? await params.opened.handle.readFile()
      : await readFileHandleBounded(params.opened.handle, maxBytes);
  return {
    buffer,
    containment: params.opened.containment,
    realPath: params.opened.realPath,
    stat: params.opened.stat,
  };
}
