import type { DirectoryReceipt } from "./directory-durability.js";
import { getNativeBinding } from "./native.js";
import { syncFileBestEffortSync } from "./file-sync.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { MutationAuthorityError } from "./mutation-authority.js";
import { suffixWindowsReservedDeviceName } from "./filename.js";
import type { FileIdentityStat } from "./file-identity.js";
import { captureNativeFdClose, type NativeBinding } from "./native-binding.js";
import { writeNativeInput } from "./native-operations.js";
import { assertNativeCopyCompleted, createNativeCopyFile } from "./copy-file-input.js";
import type { PinnedWriteInput, PinnedWriteParams } from "./pinned-write.js";
import { assertStagedDirectoryCurrent, openStagedDirectory } from "./staged-directory.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import { createNodeStagingMechanism, type StagedFileMechanism } from "./node-staged-file.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import type {
  PublishedFileReceipt,
  StagedFile,
  StagedFileCleanupReceipt,
  StagedFileFailureDetails,
  StagedFilePublication,
  StagedFileReceipt,
} from "./staged-file-types.js";

export type NativeStagingBinding = NativeBinding & Required<Pick<
  NativeBinding,
  "createStagedFile" | "stagedFileMatches" | "removeStagedFile"
>>;

export function assertNativeStaging(binding: NativeBinding): asserts binding is NativeStagingBinding {
  if (!hasNativeStaging(binding)) {
    throw new FsSafeError("helper-unavailable", "native retained-directory staging is unavailable");
  }
}

function hasNativeStaging(binding: NativeBinding): binding is NativeStagingBinding {
  return [
    binding.closeOwnedFd,
    binding.createStagedFile,
    binding.stagedFileMatches,
    binding.removeStagedFile,
    binding.renameReplace,
    binding.renameNoReplace,
  ].every((fn) => typeof fn === "function");
}

function createNativeStagingMechanism(binding: NativeStagingBinding, parentFd: number): StagedFileMechanism {
  return {
    targeting: "descriptor-relative",
    create: (name) => binding.createStagedFile(parentFd, name),
    matches: (name, fd) => binding.stagedFileMatches(parentFd, name, fd),
    publish(name, basename, overwrite) {
      if (overwrite) binding.renameReplace(parentFd, name, parentFd, basename);
      else binding.renameNoReplace(parentFd, name, parentFd, basename);
      return { method: "rename" };
    },
    remove: (name, fd) => binding.removeStagedFile(parentFd, name, fd),
    close: captureNativeFdClose(binding),
    syncParent: () => syncFileBestEffortSync(parentFd),
    copy: (input, name, maxBytes) => createNativeCopyFile(binding, input, parentFd, name, maxBytes, false),
  };
}

function assertBasename(name: string, portable: boolean): void {
  if (
    !name || name === "." || name === ".." || name.includes("/") || name.includes("\0") ||
    (portable && /[\\:\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) ||
    (portable && process.platform === "win32" &&
      (/[<>"|?*]|[ .]$/u.test(name) || suffixWindowsReservedDeviceName(name) !== name))
  ) {
    throw new FsSafeError("invalid-path", "publication requires one direct-child basename");
  }
}

const NOT_PUBLISHED = Object.freeze({ status: "not-published" as const });
const UNCOMMITTED_RENAME_ERRORS = new Set([
  "EACCES", "EBADF", "EBUSY", "EEXIST", "EINVAL", "EISDIR", "ELOOP", "EMLINK",
  "ENAMETOOLONG", "ENOENT", "ENOSPC", "ENOSYS", "ENOTDIR", "ENOTEMPTY", "ENOTSUP",
  "EPERM", "EROFS", "ETXTBSY", "EXDEV",
]);

type State =
  | { status: "open"; fileFd?: number; temporaryPresent: boolean; publication: StagedFilePublication }
  | { status: "closed"; receipt: StagedFileCleanupReceipt; error?: FsSafeError };

function failure(error: unknown, details: StagedFileFailureDetails): FsSafeError {
  const code = error instanceof FsSafeError
    ? error.code
    : (error as NodeJS.ErrnoException)?.code === "EEXIST" ? "already-exists" : "helper-failed";
  return new FsSafeError(code, `staged file ${details.phase} failed`, { cause: error, details });
}

class StagedFileOwner implements StagedFile {
  readonly #mechanism: StagedFileMechanism;
  readonly #parentFd: number;
  readonly #closeParentFd: (fd: number) => void;
  readonly #directory: StagedFileReceipt["directory"];
  readonly #portableNames: boolean;
  readonly #publishedMode: number;
  readonly #sync: boolean;
  readonly #assertBeforeMutation?: () => void;
  readonly #name = `.fs-safe-${randomUUID()}.tmp`;
  #state: State = { status: "open", temporaryPresent: false, publication: NOT_PUBLISHED };
  #receipt?: StagedFileReceipt;
  #rejectFinalSymlink = false;

  constructor(
    binding: NativeStagingBinding | undefined,
    parentFd: number,
    closeParentFd: (fd: number) => void,
    directory: StagedFileReceipt["directory"],
    portableNames: boolean,
    publishedMode: number,
    sync: boolean,
    assertBeforeMutation?: () => void,
  ) {
    this.#mechanism = binding
      ? createNativeStagingMechanism(binding, parentFd)
      : createNodeStagingMechanism(parentFd, directory);
    this.#parentFd = parentFd;
    this.#closeParentFd = closeParentFd;
    this.#directory = directory;
    this.#portableNames = portableNames;
    this.#publishedMode = publishedMode;
    this.#sync = sync;
    this.#assertBeforeMutation = assertBeforeMutation;
  }

  // Public staging supplies a Node parent; pinned writes supply a native parent.
  // The supplied closer owns parentFd even on construction or preparation failure.
  static async create(
    binding: NativeStagingBinding | undefined,
    parentFd: number,
    closeParentFd: (fd: number) => void,
    directory: StagedFileReceipt["directory"],
    input: PinnedWriteInput,
    mode: number,
    maxBytes?: number,
    // Public staging uses portable names; existing POSIX writes accept literal names.
    portableNames = true,
    sync = true,
    assertBeforeMutation?: () => void,
  ): Promise<StagedFileOwner> {
    let staged: StagedFileOwner;
    try {
      staged = new StagedFileOwner(binding, parentFd, closeParentFd, directory, portableNames, mode, sync, assertBeforeMutation);
    } catch (error) {
      try {
        closeParentFd(parentFd);
      } catch (closeError) {
        throw new AggregateError([error, closeError], "staged owner construction and close failed");
      }
      throw error;
    }
    await staged.#prepare(input, maxBytes);
    return staged;
  }

  static async write(
    binding: NativeStagingBinding,
    parentFd: number,
    closeParentFd: (fd: number) => void,
    directory: StagedFileReceipt["directory"],
    params: PinnedWriteParams,
    parentGuard: AnyAsyncDirectoryGuard,
  ): Promise<FileIdentityStat> {
    // This owner never escapes. Only the internal verifier borrows its fd;
    // public descriptor methods remain await-free and cannot race disposal.
    await using staged = await StagedFileOwner.create(
      binding, parentFd, closeParentFd, directory, params.input, params.mode, params.maxBytes, false, params.sync, params.assertBeforeMutation,
    );
    staged.#rejectFinalSymlink = params.rejectFinalSymlink === true;
    if (params.input.kind === "file") await params.input.verifySource();
    const published = await staged.publish(
      params.basename, { overwrite: params.overwrite !== false }, params.onPublished,
    );
    const identity = published.staged.identity;
    await params.verifyPublished?.(staged.#file(), identity, parentGuard);
    return { dev: identity.dev, ino: identity.ino };
  }

  get receipt(): StagedFileReceipt {
    if (!this.#receipt) {
      throw new FsSafeError("helper-failed", "staged file preparation is incomplete");
    }
    return this.#receipt;
  }

  #open(): Extract<State, { status: "open" }> {
    if (this.#state.status === "closed") {
      throw new FsSafeError("helper-failed", "staged file is closed");
    }
    return this.#state;
  }

  #file(): number {
    const state = this.#open();
    if (state.fileFd === undefined) {
      throw new FsSafeError("helper-failed", "staged file has not been created");
    }
    return state.fileFd;
  }

  #assertNamed(name: string): number {
    const fd = this.#file();
    const stat = this.#mechanism.matches(name, fd)
      ? fs.fstatSync(fd, { bigint: true }) : undefined;
    if (!stat || stat.nlink !== 1n) {
      throw new FsSafeError("path-mismatch", "staged entry no longer names the exclusive created file");
    }
    return Number(stat.mode & 0o7777n);
  }

  #assertCurrent(): void {
    if (this.#open().publication.status !== "not-published") {
      throw new FsSafeError("helper-failed", "staged file publication has already been attempted");
    }
    assertStagedDirectoryCurrent(this.#directory);
    this.#assertNamed(this.#name);
  }

  async #prepare(input: PinnedWriteInput, maxBytes?: number): Promise<void> {
    try {
      const mode = this.#publishedMode;
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
        throw new FsSafeError("invalid-path", "invalid staged file mode");
      }
      assertStagedDirectoryCurrent(this.#directory);
      // The exclusive open performs no fallible post-open checks. Store its fd
      // before every subsequent operation, including the first metadata read.
      const state = this.#open();
      this.#assertBeforeMutation?.();
      const copied = input.kind === "file" && this.#mechanism.copy
        ? await this.#mechanism.copy(input, this.#name, maxBytes)
        : undefined;
      state.fileFd = copied?.fd;
      if (state.fileFd === undefined) {
        this.#assertBeforeMutation?.();
        state.fileFd = this.#mechanism.create(this.#name);
      }
      state.temporaryPresent = true;
      const fd = state.fileFd;
      if (input.kind === "file") assertNativeCopyCompleted(input, copied);
      if (this.#mechanism.targeting === "guarded-pathname") this.#assertCurrent();
      this.#assertBeforeMutation?.();
      fs.fchmodSync(fd, 0o600);
      if (!copied) await writeNativeInput(fd, input, maxBytes, this.#assertBeforeMutation);
      if (this.#sync) syncFileBestEffortSync(fd);
      const stat = fs.fstatSync(fd, { bigint: true });
      this.#receipt = Object.freeze({
        targeting: this.#mechanism.targeting,
        directory: this.#directory,
        temporaryBasename: this.#name,
        identity: Object.freeze({
          dev: stat.dev,
          ino: stat.ino,
          mode: Number(stat.mode & 0o7777n),
          nlink: stat.nlink,
          size: stat.size,
          uid: Number(stat.uid),
          gid: Number(stat.gid),
          mtimeNs: stat.mtimeNs,
          ctimeNs: stat.ctimeNs,
        }),
      });
      this.#assertCurrent();
    } catch (error) {
      const { receipt: cleanup, error: cleanupError } = this.#finalize();
      if (cleanupError) {
        throw failure(
          new AggregateError([error, cleanupError], "preparation and cleanup failed"),
          { phase: "prepare", publication: cleanup.publication, cleanup },
        );
      }
      if (cleanup.status === "preserved") {
        throw failure(error, { phase: "prepare", publication: cleanup.publication, cleanup });
      }
      throw error;
    }
  }

  // Keep public descriptor work await-free: each call completes its mutations
  // before the next invocation, including closure and cached cleanup failures.
  async assertCurrent(): Promise<void> {
    this.#assertCurrent();
  }

  async publish(
    basename: string,
    options: { overwrite: boolean },
    onPublished?: PinnedWriteParams["onPublished"],
  ): Promise<PublishedFileReceipt> {
    const overwrite = options?.overwrite;
    try {
      const state = this.#open();
      assertBasename(basename, this.#portableNames);
      if (basename === this.#name || typeof overwrite !== "boolean") {
        throw new FsSafeError("invalid-path", "publication needs a distinct basename and explicit overwrite policy");
      }
      this.#assertCurrent();
      assertFinalSymlinkRejected(path.join(this.#directory.realPath, basename), this.#rejectFinalSymlink);
      this.#assertBeforeMutation?.();
      const rememberPublication = (method: PublishedFileReceipt["method"]) => {
        state.temporaryPresent = method === "link-unlink";
        const receipt: PublishedFileReceipt = Object.freeze({
          status: "published", staged: this.receipt, basename, overwrite, method,
        });
        state.publication = receipt;
        return receipt;
      };
      let receipt: PublishedFileReceipt;
      try {
        const dispatched = this.#mechanism.publish(this.#name, basename, overwrite, this.#file());
        receipt = rememberPublication(dispatched.method);
      } catch (error) {
        const reported = error as { details?: { commit?: unknown }; commit?: unknown } | undefined;
        const commit = reported?.details?.commit ?? reported?.commit;
        if (commit === "committed") {
          const published = rememberPublication("rename");
          try { onPublished?.(published.staged.identity); } catch (observerError) {
            throw new AggregateError([error, observerError], "committed staging publication and observer failed");
          }
        } else if (commit !== "not-attempted" &&
          (commit === "unknown" || !UNCOMMITTED_RENAME_ERRORS.has((error as NodeJS.ErrnoException | undefined)?.code ?? ""))) {
          state.publication = Object.freeze({ status: "indeterminate", basename, overwrite });
        }
        throw error;
      }
      onPublished?.(receipt.staged.identity);
      if (state.temporaryPresent) {
        if (this.#mechanism.reopenPublished) {
          // Legacy Windows unlink needs handles opened through the temporary
          // name closed. Adopt the verified sibling before closing the old fd.
          const previous = this.#file();
          state.fileFd = this.#mechanism.reopenPublished(basename, previous);
          this.#mechanism.close(previous);
        }
        const cleanup = this.#mechanism.remove(this.#name, this.#file(), basename);
        if (cleanup !== "removed" && cleanup !== "name-absent") {
          throw new FsSafeError("path-mismatch", "published stage temporary name could not be safely removed");
        }
        state.temporaryPresent = false;
      }
      const stagedMode = this.#assertNamed(basename);
      assertStagedDirectoryCurrent(this.#directory);
      // Keep contents private until the published name passes its identity
      // fence. Mode changes use the owned fd, including for final mode 000.
      const fd = this.#file();
      if (this.#publishedMode !== 0o600 || stagedMode !== 0o600) fs.fchmodSync(fd, this.#publishedMode);
      // With sync enabled, content was synced before rename. A lost chmod leaves staged 0600,
      // no wider than modes retaining owner rw. Restrictive modes and observed
      // widening of the stage still need the permission correction made durable.
      if (this.#sync && ((this.#publishedMode & 0o600) !== 0o600 || (stagedMode & ~this.#publishedMode) !== 0)) {
        syncFileBestEffortSync(fd);
      }
      if (this.#sync) this.#mechanism.syncParent();
      this.#assertNamed(basename);
      assertStagedDirectoryCurrent(this.#directory);
      return receipt;
    } catch (error) {
      if (error instanceof MutationAuthorityError) throw error;
      // Closure rejects further use, not the recorded outcome of an earlier publication.
      const publication = this.#state.status === "closed"
        ? this.#state.receipt.publication
        : this.#state.publication;
      throw failure(error, { phase: "publish", publication });
    }
  }

  #finalize(): Extract<State, { status: "closed" }> {
    if (this.#state.status === "closed") {
      return this.#state;
    }
    const state = this.#state;
    let outcome: StagedFileCleanupReceipt["status"] = "not-needed";
    const errors: unknown[] = [];
    if (state.publication.status === "indeterminate") {
      outcome = "preserved";
    } else if (state.temporaryPresent && state.fileFd !== undefined) {
      try {
        outcome = this.#mechanism.remove(
          this.#name, state.fileFd,
          state.publication.status === "published" ? state.publication.basename : undefined,
        );
      } catch (error) {
        outcome = "failed";
        errors.push(error);
      }
    }
    let resources: StagedFileCleanupReceipt["resources"] = "closed";
    for (const [fd, closeFd] of [
      [state.fileFd, this.#mechanism.close],
      [this.#parentFd, this.#closeParentFd],
    ] as const) {
      if (fd === undefined) {
        continue;
      }
      try {
        closeFd(fd);
      } catch (error) {
        resources = "close-failed";
        errors.push(error);
      }
    }
    const receipt = Object.freeze({
      targeting: this.#mechanism.targeting,
      temporaryBasename: this.#name,
      publication: state.publication,
      status: outcome,
      resources,
    });
    const error = errors.length ? failure(
      errors.length === 1 ? errors[0] : new AggregateError(errors, "staged cleanup failed"),
      { phase: "cleanup", publication: state.publication, cleanup: receipt },
    ) : undefined;
    this.#state = { status: "closed", receipt, error };
    return this.#state;
  }

  async cleanup(): Promise<StagedFileCleanupReceipt> {
    const closed = this.#finalize();
    if (closed.error) {
      throw closed.error;
    }
    return closed.receipt;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const cleanup = await this.cleanup();
    if (cleanup.status === "preserved") {
      throw new FsSafeError("not-removable", "staged cleanup preserved an unverified entry", {
        details: { phase: "cleanup", publication: cleanup.publication, cleanup } satisfies StagedFileFailureDetails,
      });
    }
  }
}

export const createNativeStage: (...args: Parameters<typeof StagedFileOwner.create>) => Promise<StagedFile> =
  StagedFileOwner.create;
export const writeNativeStage = StagedFileOwner.write;

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
  const binding = getNativeBinding();
  const native = binding && (process.platform === "linux" || process.platform === "darwin") && hasNativeStaging(binding)
    ? binding : undefined;
  if (!native) {
    warnNativeFallback("staged-file", "Staging uses guarded pathname operations; cleanup cannot follow a moved parent directory.");
  }
  const input = { kind: "buffer" as const, data: Buffer.from(options.content) };
  const mode = options.mode ?? 0o600;
  const parent = openStagedDirectory(options.directory);
  return await StagedFileOwner.create(native, parent.fd, fs.closeSync, parent.receipt, input, mode);
}
