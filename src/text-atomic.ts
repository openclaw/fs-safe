import { replaceFileAtomic, type ReplaceFileAtomicOptions } from "./replace-file.js";
import { admitStandalonePublicationPath } from "./windows-path-alias.js";

export type WriteTextAtomicOptions = Pick<ReplaceFileAtomicOptions, "beforeRename" | "tempPrefix"> & {
  mode?: number;
  dirMode?: number;
  trailingNewline?: boolean;
  /**
   * When false, skip the temp-file and parent-directory fsync calls while
   * preserving the temp-file replace/rename behavior.
   *
   * Defaults to true.
   */
  durable?: boolean;
};

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: WriteTextAtomicOptions,
): Promise<void> {
  const admittedPath = admitStandalonePublicationPath(filePath);
  const payload = options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  const durable = options?.durable ?? true;
  await replaceFileAtomic({
    filePath: admittedPath,
    content: payload,
    mode: options?.mode ?? 0o600,
    dirMode: options?.dirMode ?? (0o777 & ~process.umask()),
    copyFallbackOnPermissionError: true,
    syncTempFile: durable,
    syncParentDir: durable,
    beforeRename: options?.beforeRename,
    tempPrefix: options?.tempPrefix,
  });
}
