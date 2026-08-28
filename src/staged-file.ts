import type { DirectoryReceipt } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { assertNativeStaging, createNativeStage } from "./native-staged-file.js";
import { requireNativeBinding } from "./native.js";
import { openStagedDirectory } from "./staged-directory.js";
import type { StagedFile } from "./staged-file-types.js";

export type {
  PublishedFileReceipt, StagedFile, StagedFileCleanupReceipt, StagedFileFailureDetails,
  StagedFilePublication, StagedFileReceipt,
} from "./staged-file-types.js";

export async function stageFileInDirectory(options: {
  directory: string | DirectoryReceipt;
  content: string | Uint8Array;
  /** Published mode; the unpublished stage stays at 0600. Defaults to 0600. */
  mode?: number;
}): Promise<StagedFile> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new FsSafeError("unsupported-platform", "retained-directory staging requires Linux or macOS");
  }
  const binding = requireNativeBinding();
  assertNativeStaging(binding);
  const input = { kind: "buffer" as const, data: Buffer.from(options.content) };
  const mode = options.mode ?? 0o600;
  const parent = openStagedDirectory(options.directory);
  return await createNativeStage(binding, parent.fd, parent.receipt, input, mode);
}
