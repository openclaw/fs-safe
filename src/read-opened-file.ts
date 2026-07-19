import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { readFileHandleBounded } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";

export type ReadResult = {
  buffer: Buffer;
  realPath: string;
  stat: Stats;
};

type OpenedFile = {
  handle: FileHandle;
  realPath: string;
  stat: Stats;
};

export async function readOpenedFileSafely(params: {
  opened: OpenedFile;
  maxBytes?: number;
}): Promise<ReadResult> {
  if (params.maxBytes !== undefined && params.opened.stat.size > params.maxBytes) {
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${params.maxBytes} bytes (got ${params.opened.stat.size})`,
    );
  }
  const buffer =
    params.maxBytes === undefined
      ? await params.opened.handle.readFile()
      : await readFileHandleBounded(params.opened.handle, params.maxBytes);
  return {
    buffer,
    realPath: params.opened.realPath,
    stat: params.opened.stat,
  };
}
