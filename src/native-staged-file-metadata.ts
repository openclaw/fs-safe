import { FsSafeError } from "./errors.js";
import type { StagedFileReceipt } from "./staged-file-types.js";
import type { NativeBinding } from "./native-binding.js";

/** Exact nonprivate stage facts from one fresh named/retained observation. */
export function nativeStagedFileMode(
  binding: NativeBinding, parentFd: number, name: string, fd: number, expectedMode?: number,
): number | undefined {
  if (typeof binding.stagedFileMetadata !== "function") return undefined;
  const stat = binding.stagedFileMetadata(parentFd, name, fd);
  if (!stat || typeof stat.mode !== "bigint" || stat.mode < 0n || stat.mode > 0xffff_ffffn ||
    typeof stat.nlink !== "bigint" || stat.nlink !== 1n || (stat.mode & 0o170000n) !== 0o100000n) {
    throw new FsSafeError("path-mismatch", "staged entry no longer names the exclusive created file");
  }
  const mode = Number(stat.mode & 0o7777n);
  if (expectedMode !== undefined && mode !== expectedMode) {
    throw new FsSafeError("insecure-permissions", "filesystem did not enforce the staged file mode");
  }
  return mode;
}

export type NativeStagingBinding = NativeBinding & Required<Pick<
  NativeBinding,
  "createStagedFile" | "stagedFileMatches" | "removeStagedFile" | "renameReplaceAsync" | "renameNoReplaceAsync"
>>;

export function assertNativeStaging(binding: NativeBinding): asserts binding is NativeStagingBinding {
  if ([
    binding.closeOwnedFd,
    binding.createStagedFile,
    binding.stagedFileMatches,
    binding.removeStagedFile,
    binding.renameReplaceAsync,
    binding.renameNoReplaceAsync,
  ].some((fn) => typeof fn !== "function")) {
    throw new FsSafeError("helper-unavailable", "native retained-directory staging is unavailable");
  }
}

export function assertStagedFileBasename(name: string, portable: boolean): void {
  if (
    !name || name === "." || name === ".." || name.includes("/") || name.includes("\0") ||
    (portable && /[\\:\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name))
  ) {
    throw new FsSafeError("invalid-path", "publication requires one direct-child basename");
  }
}

type StagedPermissionPolicy = "private-creation" | "mode-only";

export type NativeStageOwner = Readonly<{
  binding: NativeStagingBinding;
  parentFd: number;
  closeParentFd: (fd: number) => void;
  directory: StagedFileReceipt["directory"];
  portableNames?: boolean;
  mode: number;
  sync?: boolean;
  allowDrvfsRenameRecovery?: boolean;
  strictFileSync?: boolean;
  assertBeforeMutation?: () => void;
  permissionPolicy?: StagedPermissionPolicy;
  name?: string;
}>;
