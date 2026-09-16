import type { BigIntStats } from "node:fs";
import fsSync from "node:fs";
import { FsSafeError } from "./errors.js";
import type { NativeBinding, NativeOwnedTreeRemovalResult } from "./native-binding.js";
import { getNativeBinding } from "./native.js";
import { exactIdentityMatches, openStagedDirectory } from "./staged-directory.js";

type RenameBinding = NativeBinding & Required<Pick<NativeBinding, "renameNoReplace">>;
type CleanupBinding = RenameBinding & Required<Pick<NativeBinding,
  "ownedTreeRemovalAvailable" | "removeOwnedTree">>;

export type RetainedReplacementParent = Readonly<{
  path: string;
  realPath: string;
  identity: Pick<BigIntStats, "dev" | "ino">;
}>;

function helperUnavailable(message: string, cause?: unknown): FsSafeError {
  return new FsSafeError("helper-unavailable", message, {
    ...(cause instanceof Error ? { cause } : {}),
  });
}

function copyOperationalCode(target: Error, source: unknown): void {
  const code = (source as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string") {
    Object.defineProperty(target, "code", { configurable: true, value: code });
  }
}

function primaryWithCloseFailure(
  error: unknown,
  closeError: unknown,
  message: string,
): Error {
  const cause = new AggregateError([error, closeError], message);
  if (error instanceof FsSafeError) {
    return new FsSafeError(error.code, message, {
      cause,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  const wrapped = new Error(message, { cause });
  copyOperationalCode(wrapped, error);
  return wrapped;
}

function supportsRename(binding: NativeBinding | undefined): binding is RenameBinding {
  return typeof binding?.renameNoReplace === "function";
}

function supportsCleanup(binding: RenameBinding): binding is CleanupBinding {
  return typeof binding.ownedTreeRemovalAvailable === "function" &&
    typeof binding.removeOwnedTree === "function";
}

function closeDescriptors(descriptors: readonly (number | undefined)[]): void {
  const errors: unknown[] = [];
  const closed = new Set<number>();
  for (const fd of descriptors) {
    if (fd === undefined || closed.has(fd)) continue;
    closed.add(fd);
    try {
      fsSync.closeSync(fd);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "retained directory replacement descriptors failed to close");
  }
}

function openParent(
  label: "staged" | "target",
  expected: RetainedReplacementParent,
): number {
  let opened: ReturnType<typeof openStagedDirectory>;
  try {
    opened = openStagedDirectory(expected.path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EACCES" || code === "EPERM") {
      throw helperUnavailable(`atomic directory replacement cannot retain the ${label} parent`, error);
    }
    throw error;
  }
  if (
    !exactIdentityMatches(expected.identity, opened.receipt.identity) ||
    opened.receipt.realPath !== expected.realPath
  ) {
    try {
      fsSync.closeSync(opened.fd);
    } catch (closeError) {
      throw primaryWithCloseFailure(
        new FsSafeError("path-mismatch", `directory replacement ${label} parent changed during admission`),
        closeError,
        `directory replacement ${label} parent admission and close failed`,
      );
    }
    throw new FsSafeError(
      "path-mismatch",
      `directory replacement ${label} parent changed during admission`,
    );
  }
  return opened.fd;
}

function openOriginalDirectory(
  pathname: string,
  expected: Pick<BigIntStats, "dev" | "ino">,
): number {
  let opened: ReturnType<typeof openStagedDirectory>;
  try {
    opened = openStagedDirectory(pathname);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EACCES" || code === "EPERM") {
      throw helperUnavailable(
        "atomic directory replacement cannot retain the original target for bounded cleanup",
        error,
      );
    }
    throw error;
  }
  if (!exactIdentityMatches(expected, opened.receipt.identity)) {
    try {
      fsSync.closeSync(opened.fd);
    } catch (closeError) {
      throw primaryWithCloseFailure(
        new FsSafeError("path-mismatch", "directory replacement target changed during admission"),
        closeError,
        "directory replacement target admission and close failed",
      );
    }
    throw new FsSafeError("path-mismatch", "directory replacement target changed during admission");
  }
  return opened.fd;
}

export class RetainedDirectoryReplacement {
  readonly #binding: RenameBinding;
  readonly #originalDirectoryFd: number | undefined;
  readonly #stagedParentFd: number;
  readonly #targetParentFd: number;
  #cleanupUsed = false;
  #closed = false;

  private constructor(
    binding: RenameBinding,
    targetParentFd: number,
    stagedParentFd: number,
    originalDirectoryFd: number | undefined,
  ) {
    this.#binding = binding;
    this.#targetParentFd = targetParentFd;
    this.#stagedParentFd = stagedParentFd;
    this.#originalDirectoryFd = originalDirectoryFd;
  }

  static requireBinding(): RenameBinding {
    const binding = getNativeBinding();
    if (!supportsRename(binding)) {
      throw helperUnavailable("atomic directory replacement requires native no-replace rename support");
    }
    return binding;
  }

  static retain(params: {
    targetParent: RetainedReplacementParent;
    stagedParent: RetainedReplacementParent;
    originalTarget?: Readonly<{
      path: string;
      identity: Pick<BigIntStats, "dev" | "ino">;
    }>;
  }, binding = RetainedDirectoryReplacement.requireBinding()): RetainedDirectoryReplacement {
    let targetParentFd: number | undefined;
    let stagedParentFd: number | undefined;
    let originalDirectoryFd: number | undefined;
    try {
      targetParentFd = openParent("target", params.targetParent);
      stagedParentFd = params.stagedParent.path === params.targetParent.path
        ? targetParentFd
        : openParent("staged", params.stagedParent);

      if (params.originalTarget) {
        if (!supportsCleanup(binding)) {
          throw helperUnavailable(
            "replacing an existing directory requires native bounded owned-tree cleanup",
          );
        }
        let available = false;
        try {
          available = binding.ownedTreeRemovalAvailable(targetParentFd) === true;
        } catch (error) {
          throw helperUnavailable("native owned-tree cleanup capability probe failed", error);
        }
        if (!available) {
          throw helperUnavailable("native owned-tree cleanup is unavailable for the target parent");
        }
        originalDirectoryFd = openOriginalDirectory(
          params.originalTarget.path,
          params.originalTarget.identity,
        );
      }

      return new RetainedDirectoryReplacement(
        binding,
        targetParentFd,
        stagedParentFd,
        originalDirectoryFd,
      );
    } catch (error) {
      try {
        closeDescriptors([originalDirectoryFd, stagedParentFd, targetParentFd]);
      } catch (closeError) {
        throw primaryWithCloseFailure(
          error,
          closeError,
          "retained directory replacement admission and descriptor close failed",
        );
      }
      throw error;
    }
  }

  renameNoReplace(
    sourceParent: "staged" | "target",
    sourceBasename: string,
    targetBasename: string,
  ): void {
    if (this.#closed) {
      throw new FsSafeError("path-mismatch", "retained directory rename authority is unavailable");
    }
    this.#binding.renameNoReplace(
      sourceParent === "staged" ? this.#stagedParentFd : this.#targetParentFd,
      sourceBasename,
      this.#targetParentFd,
      targetBasename,
    );
  }

  async removeOriginal(backupBasename: string): Promise<NativeOwnedTreeRemovalResult["outcome"]> {
    if (this.#closed || this.#cleanupUsed || this.#originalDirectoryFd === undefined ||
      !supportsCleanup(this.#binding)) {
      throw new FsSafeError("path-mismatch", "retained owned-tree cleanup authority is unavailable");
    }
    this.#cleanupUsed = true;
    const result = await this.#binding.removeOwnedTree(
      this.#targetParentFd,
      backupBasename,
      this.#originalDirectoryFd,
    );
    if (result.errorCode) {
      if (result.errorCode === "path-mismatch") {
        throw new FsSafeError(
          "path-mismatch",
          result.errorMessage ?? "native owned-tree cleanup lost retained identity",
        );
      }
      throw Object.assign(
        new Error(result.errorMessage ?? "native owned-tree cleanup failed"),
        { code: result.errorCode },
      );
    }
    if (result.outcome !== "removed" && result.outcome !== "preserved") {
      throw helperUnavailable("native owned-tree cleanup returned an invalid result");
    }
    return result.outcome;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeDescriptors([
      this.#originalDirectoryFd,
      this.#stagedParentFd,
      this.#targetParentFd,
    ]);
  }
}
