import type { FileHandle } from "node:fs/promises";
import { writeCopyFileToFd } from "./copy-file-input.js";
import { FsSafeError } from "./errors.js";
import type { PinnedWriteInput } from "./pinned-write-types.js";
import { writeAllToFile } from "./write-file-handle.js";

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
  const write = async (data: Buffer) => {
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
      await write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
  }
}
