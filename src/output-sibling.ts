import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeCallbackSibling } from "./sibling-staged-file.js";

function buildSiblingTempPath(targetPath: string, fallbackFileName?: string): string {
  // NOTE: keep the temp basename within 8.3 (<=12 chars): FAT-family filesystems
  // (exFAT/FAT32 USB sticks) do not preserve file identity across rename for
  // longer basenames. Long prefixes + caller filename tails would exceed the
  // short-name budget, so use a bare 8-hex-char uuid stem here; the caller
  // filename is still honored via fitFileNameToPortableComponent only for the
  // final name, never the temp name.
  void fallbackFileName;
  void targetPath;
  return path.join(path.dirname(targetPath), `${randomUUID().slice(0, 8)}.tmp`);
}

export async function writeExternalFileViaSibling<T>(params: {
  finalPath: string;
  write: (filePath: string) => Promise<T>;
  fallbackFileName?: string;
  maxBytes?: number;
  mode?: number;
}): Promise<T> {
  const finalPath = path.resolve(params.finalPath);
  const { result } = await writeCallbackSibling({
    tempPath: buildSiblingTempPath(finalPath, params.fallbackFileName),
    write: params.write,
    resolveFinalPath: () => finalPath,
    mode: params.mode,
    maxBytes: params.maxBytes,
    syncTempFile: true,
    syncParentDir: true,
  });
  return result;
}
