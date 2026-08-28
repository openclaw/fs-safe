import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { AsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import type { NativeBinding } from "./native-binding.js";
import { syncNativeFileBestEffort, writeNativeInput } from "./native-operations.js";
import type { PinnedWriteInput, PinnedWriteParams } from "./pinned-write.js";
import { assertStagedDirectoryCurrent } from "./staged-directory.js";
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
  if ([
    binding.createStagedFile,
    binding.stagedFileMatches,
    binding.removeStagedFile,
    binding.renameReplace,
    binding.renameNoReplace,
  ].some((fn) => typeof fn !== "function")) {
    throw new FsSafeError("helper-unavailable", "native retained-directory staging is unavailable");
  }
}

function assertBasename(name: string, portable: boolean): void {
  if (
    !name || name === "." || name === ".." || name.includes("/") || name.includes("\0") ||
    (portable && /[\\:\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name))
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
  | { status: "open"; fileFd?: number; publication: StagedFilePublication }
  | { status: "closed"; receipt: StagedFileCleanupReceipt; error?: FsSafeError };

function failure(error: unknown, details: StagedFileFailureDetails): FsSafeError {
  const code = error instanceof FsSafeError
    ? error.code
    : (error as NodeJS.ErrnoException)?.code === "EEXIST" ? "already-exists" : "helper-failed";
  return new FsSafeError(code, `staged file ${details.phase} failed`, { cause: error, details });
}

class NativeStagedFile implements StagedFile {
  readonly #binding: NativeStagingBinding;
  readonly #parentFd: number;
  readonly #directory: StagedFileReceipt["directory"];
  readonly #portableNames: boolean;
  readonly #publishedMode: number;
  readonly #name = `.fs-safe-${randomUUID()}.tmp`;
  #state: State = { status: "open", publication: NOT_PUBLISHED };
  #receipt?: StagedFileReceipt;

  constructor(
    binding: NativeStagingBinding,
    parentFd: number,
    directory: StagedFileReceipt["directory"],
    portableNames: boolean,
    publishedMode: number,
  ) {
    this.#binding = binding;
    this.#parentFd = parentFd;
    this.#directory = directory;
    this.#portableNames = portableNames;
    this.#publishedMode = publishedMode;
  }

  // Takes ownership of parentFd, including all construction and preparation failures.
  static async create(
    binding: NativeStagingBinding,
    parentFd: number,
    directory: StagedFileReceipt["directory"],
    input: PinnedWriteInput,
    mode: number,
    maxBytes?: number,
    // Public staging uses portable names; existing POSIX writes accept literal names.
    portableNames = true,
  ): Promise<NativeStagedFile> {
    let staged: NativeStagedFile;
    try {
      staged = new NativeStagedFile(binding, parentFd, directory, portableNames, mode);
    } catch (error) {
      try {
        fs.closeSync(parentFd);
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
    directory: StagedFileReceipt["directory"],
    params: PinnedWriteParams,
    parentGuard: AsyncDirectoryGuard,
  ): Promise<FileIdentityStat> {
    // This owner never escapes. Only the internal verifier borrows its fd;
    // public descriptor methods remain await-free and cannot race disposal.
    await using staged = await NativeStagedFile.create(
      binding, parentFd, directory, params.input, params.mode, params.maxBytes, false,
    );
    const published = await staged.publish(params.basename, { overwrite: params.overwrite !== false });
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

  #assertNamed(name: string): void {
    const fd = this.#file();
    if (
      !this.#binding.stagedFileMatches(this.#parentFd, name, fd) ||
      fs.fstatSync(fd, { bigint: true }).nlink !== 1n
    ) {
      throw new FsSafeError("path-mismatch", "staged entry no longer names the exclusive created file");
    }
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
      state.fileFd = this.#binding.createStagedFile(this.#parentFd, this.#name);
      const fd = state.fileFd;
      fs.fchmodSync(fd, 0o600);
      await writeNativeInput(fd, input, maxBytes);
      syncNativeFileBestEffort(fd);
      const stat = fs.fstatSync(fd, { bigint: true });
      this.#receipt = Object.freeze({
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

  async publish(basename: string, options: { overwrite: boolean }): Promise<PublishedFileReceipt> {
    const overwrite = options?.overwrite;
    try {
      const state = this.#open();
      assertBasename(basename, this.#portableNames);
      if (basename === this.#name || typeof overwrite !== "boolean") {
        throw new FsSafeError("invalid-path", "publication needs a distinct basename and explicit overwrite policy");
      }
      this.#assertCurrent();
      try {
        if (overwrite) {
          this.#binding.renameReplace(this.#parentFd, this.#name, this.#parentFd, basename);
        } else {
          this.#binding.renameNoReplace(this.#parentFd, this.#name, this.#parentFd, basename);
        }
      } catch (error) {
        // Unknown rename errors can be indeterminate on remote filesystems.
        if (!UNCOMMITTED_RENAME_ERRORS.has((error as NodeJS.ErrnoException | undefined)?.code ?? "")) {
          state.publication = Object.freeze({ status: "indeterminate", basename, overwrite });
        }
        throw error;
      }
      // Commit is recorded synchronously before any post-rename operation.
      const receipt: PublishedFileReceipt = Object.freeze({
        status: "published",
        staged: this.receipt,
        basename,
        overwrite,
      });
      state.publication = receipt;
      this.#assertNamed(basename);
      assertStagedDirectoryCurrent(this.#directory);
      // Keep contents private until the published name passes its identity
      // fence. Mode changes use the owned fd, including for final mode 000.
      const fd = this.#file();
      fs.fchmodSync(fd, this.#publishedMode);
      syncNativeFileBestEffort(fd);
      syncNativeFileBestEffort(this.#parentFd);
      this.#assertNamed(basename);
      assertStagedDirectoryCurrent(this.#directory);
      return receipt;
    } catch (error) {
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
    } else if (state.publication.status === "not-published" && state.fileFd !== undefined) {
      try {
        outcome = this.#binding.removeStagedFile(this.#parentFd, this.#name, state.fileFd);
      } catch (error) {
        outcome = "failed";
        errors.push(error);
      }
    }
    let resources: StagedFileCleanupReceipt["resources"] = "closed";
    for (const fd of [state.fileFd, this.#parentFd]) {
      if (fd === undefined) {
        continue;
      }
      try {
        fs.closeSync(fd);
      } catch (error) {
        resources = "close-failed";
        errors.push(error);
      }
    }
    const receipt = Object.freeze({
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

export const createNativeStage: (...args: Parameters<typeof NativeStagedFile.create>) => Promise<StagedFile> =
  NativeStagedFile.create;
export const writeNativeStage = NativeStagedFile.write;
