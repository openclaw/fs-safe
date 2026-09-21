import fs from "node:fs";
import { FsSafeError } from "./errors.js";
import { assertFileStoreMaxBytes } from "./file-store-limit.js";
import { readRegularFile } from "./regular-file.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

export async function readFileStoreCopySource(params: {
  sourcePath: string;
  maxBytes: number;
}): Promise<Buffer> {
  assertNoWindowsPathAlias(
    params.sourcePath,
    "filesystem",
    "source path uses a Windows filesystem namespace alias",
  );
  const sourceStat = fs.lstatSync(params.sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new FsSafeError("not-file", "source path is not a file");
  }
  assertFileStoreMaxBytes(sourceStat.size, params.maxBytes);
  try {
    return (await readRegularFile({ filePath: params.sourcePath, maxBytes: params.maxBytes }))
      .buffer;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("regular file") || message.includes("not a regular file")) {
      throw new FsSafeError("not-file", "source path is not a file", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (message.includes(`exceeds ${params.maxBytes} bytes`)) {
      throw new FsSafeError("too-large", `file exceeds maximum size of ${params.maxBytes} bytes`, {
        cause: error instanceof Error ? error : undefined,
      });
    }
    throw error;
  }
}
