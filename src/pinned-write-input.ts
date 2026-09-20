import type { FileHandle } from "node:fs/promises";
import { types } from "node:util";
import { snapshotByteView } from "./byte-view.js";
import { writeCopyFileToFd } from "./copy-file-input.js";
import { FsSafeError } from "./errors.js";
import type { PinnedWriteInput } from "./pinned-write-types.js";
import { writeAllToFile } from "./write-file-handle.js";

const isUint8Array = types.isUint8Array;

function streamChunkBytes(chunk: unknown): Uint8Array {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (!isUint8Array(chunk)) return Buffer.from(chunk as Uint8Array);
  return snapshotByteView(chunk);
}

export async function writePinnedInput(
  target: FileHandle | number,
  input: PinnedWriteInput,
  maxBytes?: number,
  assertBeforeMutation?: () => void,
): Promise<void> {
  if (input.kind === "file") {
    await writeCopyFileToFd(typeof target === "number" ? target : target.fd, input, maxBytes, assertBeforeMutation);
    return;
  }
  let bytes = 0;
  const write = async (data: Uint8Array) => {
    bytes += data.byteLength;
    if (maxBytes !== undefined && bytes > maxBytes) {
      throw new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`);
    }
    await writeAllToFile(target, data, { assertBeforeMutation });
  };
  if (input.kind === "buffer") {
    await write(typeof input.data === "string" ? Buffer.from(input.data, input.encoding ?? "utf8") : input.data);
  } else {
    for await (const chunk of input.stream) {
      await write(streamChunkBytes(chunk));
    }
  }
}
