import { randomUUID } from "node:crypto";
import path from "node:path";
import { fitFileNameToPortableComponent, sanitizeUntrustedFileName } from "./filename.js";
import { writeCallbackSibling } from "./sibling-staged-file.js";

function safeFallbackFileName(fallbackFileName?: string): string {
  return sanitizeUntrustedFileName(fallbackFileName ?? "output.bin", "output.bin");
}

function buildSiblingTempPath(targetPath: string, fallbackFileName?: string): string {
  const prefix = `.fs-safe-output-${process.pid}-${randomUUID()}-`;
  const suffix = ".part";
  const safeTail = fitFileNameToPortableComponent({
    prefix,
    fileName: sanitizeUntrustedFileName(
      path.basename(targetPath),
      safeFallbackFileName(fallbackFileName),
    ),
    suffix,
  });
  return path.join(path.dirname(targetPath), `${prefix}${safeTail}${suffix}`);
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
