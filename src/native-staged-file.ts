import type { DirectoryReceipt } from "./directory-durability.js";
import { assertDarwinCreationAcl } from "./creation-darwin.js";
import { assertPrivateCreationFile } from "./creation-file-state.js";
import { requireNativeBinding } from "./native.js";
import { syncFileBestEffortSync } from "./file-sync.js";
import { randomUUID } from "node:crypto";
import fs, { type BigIntStats, type Stats } from "node:fs";
import path from "node:path";
import type { AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult, MutationAuthorityError } from "./mutation-authority.js";
import type { FileIdentityStat } from "./file-identity.js";
import { captureNativeFdClose, type NativeBinding } from "./native-binding.js";
import { writePinnedInput } from "./pinned-write-input.js";
import { assertNativeCopyCompleted, createNativeCopyFile } from "./copy-file-input.js";
import type { PinnedWriteInput, PinnedWriteParams } from "./pinned-write.js";
import { assertStagedDirectoryCurrent, openStagedDirectory } from "./staged-directory.js";
import { assertFinalSymlinkRejected } from "./root-symlink-policy.js";
import type {
  PublishedFileReceipt,
  StagedFile,
  StagedFileCleanupReceipt,
  StagedFileFailureDetails,
  StagedFilePublication,
  StagedFileReceipt,
} from "./staged-file-types.js";
import { classifyNativeRenameFailure } from "./native-rename-outcome.js";
import { createStagedFileReceipt, stagedFileFailure as failure } from "./staged-file-settlement.js";

export type NativeStagingBinding = NativeBinding & Required<Pick<
  NativeBinding,
  "createStagedFile" | "stagedFileMatches" | "removeStagedFile"
>>;

export function assertNativeStaging(binding: NativeBinding): asserts binding is NativeStagingBinding {
  if ([
    binding.closeOwnedFd,
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
type State =
  | { status: "open"; fileFd?: number; publication: StagedFilePublication }
  | { status: "closed"; receipt: StagedFileCleanupReceipt; error?: FsSafeError };
type StagedPermissionPolicy = "private-creation" | "mode-only";

class NativeStagedFile implements StagedFile {
  readonly #binding: NativeStagingBinding;
  readonly #closeFd: (fd: number) => void;
  readonly #parentFd: number;
  readonly #closeParentFd: (fd: number) => void;
  readonly #directory: StagedFileReceipt["directory"];
  readonly #portableNames: boolean;
  readonly #publishedMode: number;
  readonly #sync: boolean;
  readonly #strictFileSync: boolean;
  readonly #private: boolean;
  readonly #verifyMode: boolean;
  readonly #assertBeforeMutation?: () => void;
  readonly #name: string;
  #state: State = { status: "open", publication: NOT_PUBLISHED };
  #receipt?: StagedFileReceipt;
  #rejectFinalSymlink = false;

  constructor(
    binding: NativeStagingBinding,
    parentFd: number,
    closeParentFd: (fd: number) => void,
    directory: StagedFileReceipt["directory"],
    portableNames: boolean,
    publishedMode: number,
    sync: boolean,
    assertBeforeMutation?: () => void,
    name = `.fs-safe-${randomUUID()}.tmp`,
    strictFileSync = false,
    permissionPolicy?: StagedPermissionPolicy,
  ) {
    assertBasename(name, portableNames);
    this.#name = name;
    this.#closeFd = captureNativeFdClose(binding);
    this.#binding = binding;
    this.#parentFd = parentFd;
    this.#closeParentFd = closeParentFd;
    this.#directory = directory;
    this.#portableNames = portableNames;
    this.#publishedMode = publishedMode;
    this.#sync = sync;
    this.#strictFileSync = strictFileSync;
    this.#private = permissionPolicy === "private-creation";
    this.#verifyMode = permissionPolicy !== undefined;
    this.#assertBeforeMutation = assertBeforeMutation;
  }

  // Public staging supplies a Node parent; pinned writes supply a native parent.
  // The supplied closer owns parentFd even on construction or preparation failure.
  static async create(
    binding: NativeStagingBinding,
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
    exclusiveBasename?: string,
    strictFileSync = false,
    permissionPolicy?: StagedPermissionPolicy,
  ): Promise<NativeStagedFile> {
    let staged: NativeStagedFile;
    try {
      staged = new NativeStagedFile(binding, parentFd, closeParentFd, directory, portableNames, mode, sync, assertBeforeMutation, exclusiveBasename, strictFileSync, permissionPolicy);
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
    const exclusive = params.overwrite === false && params.input.kind === "buffer" && params.input.stageBeforePublish === false;
    // This owner never escapes. Only the internal verifier borrows its fd;
    // public descriptor methods remain await-free and cannot race disposal.
    await using staged = await NativeStagedFile.create(
      binding, parentFd, closeParentFd, directory, params.input, params.mode, params.maxBytes, false, params.sync, params.assertBeforeMutation,
      exclusive ? params.basename : undefined,
      params.strictFileSync,
      params.private ? "private-creation" : params.verifyPosixMode === true ? "mode-only" : undefined,
    );
    staged.#rejectFinalSymlink = params.rejectFinalSymlink === true;
    if (params.input.kind === "file") await params.input.verifySource();
    if (exclusive) {
      staged.#assertCurrent();
      params.assertBeforeMutation?.();
      if (staged.#verifyMode) staged.#assertCurrent();
    }
    const published = exclusive
      ? staged.#completePublication(params.basename, false, params.onPublished)
      : await staged.publish(params.basename, { overwrite: params.overwrite !== false }, params.onPublished);
    const identity = published.staged.identity;
    try {
      await params.verifyPublished?.(staged.#file(), identity, parentGuard);
    } catch (error) {
      if (params.overwrite === false && params.input.kind !== "file" && params.input.stageBeforePublish === true) {
        throw failure(error, { phase: "publish", publication: published });
      }
      throw error;
    }
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

  #assertNamed(name: string, expectedMode: number): number {
    const fd = this.#file();
    const stat = this.#binding.stagedFileMatches(this.#parentFd, name, fd)
      ? fs.fstatSync(fd, { bigint: true }) : undefined;
    if (!stat || stat.nlink !== 1n) {
      throw new FsSafeError("path-mismatch", "staged entry no longer names the exclusive created file");
    }
    this.#assertPermissions(fd, stat, expectedMode);
    return Number(stat.mode & 0o7777n);
  }

  #assertCurrent(): void {
    if (this.#open().publication.status !== "not-published") {
      throw new FsSafeError("helper-failed", "staged file publication has already been attempted");
    }
    assertStagedDirectoryCurrent(this.#directory);
    this.#assertNamed(this.#name, 0o600);
  }

  #assertPermissions(fd: number, stat: fs.BigIntStats, expectedMode: number): void {
    if (this.#private) assertPrivateCreationFile(stat, fd);
    if (this.#verifyMode && Number(stat.mode & 0o7777n) !== expectedMode) {
      throw new FsSafeError("insecure-permissions", "filesystem did not enforce the staged file mode");
    }
  }

  #assertStagePermissions(fd: number): void {
    this.#assertPermissions(fd, fs.fstatSync(fd, { bigint: true }), 0o600);
  }

  async #prepare(input: PinnedWriteInput, maxBytes?: number): Promise<void> {
    try {
      const mode = this.#publishedMode;
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
        throw new FsSafeError("invalid-path", "invalid staged file mode");
      }
      const fileSignal = input.kind === "file" && this.#verifyMode ? input.signal : undefined;
      if (input.kind === "file" && this.#verifyMode) {
        fileSignal?.throwIfAborted();
        if (input.clone === "always") {
          throw new FsSafeError("helper-unavailable", "required cloning cannot verify staged permissions before copying");
        }
      }
      assertStagedDirectoryCurrent(this.#directory);
      // The exclusive open performs no fallible post-open checks. Store its fd
      // before every subsequent operation, including the first metadata read.
      const state = this.#open();
      if (this.#private) assertDarwinCreationAcl(this.#parentFd, "file");
      this.#assertBeforeMutation?.();
      if (this.#private) assertDarwinCreationAcl(this.#parentFd, "file");
      // Native copying populates its new file before returning its descriptor.
      const copied = input.kind === "file" && !this.#verifyMode
        ? await createNativeCopyFile(this.#binding, input, this.#parentFd, this.#name, maxBytes, false)
        : undefined;
      state.fileFd = copied?.fd;
      if (state.fileFd === undefined) {
        this.#assertBeforeMutation?.();
        if (this.#private) assertDarwinCreationAcl(this.#parentFd, "file");
        state.fileFd = this.#binding.createStagedFile(this.#parentFd, this.#name);
      }
      const fd = state.fileFd;
      if (input.kind === "file") assertNativeCopyCompleted(input, copied);
      const beforeChmodResult = this.#assertBeforeMutation?.();
      if (this.#private) {
        assertSynchronousCallbackResult(beforeChmodResult, "assertBeforeMutation");
        assertPrivateCreationFile(fs.fstatSync(fd, { bigint: true }), fd);
      }
      fs.fchmodSync(fd, 0o600);
      // Some filesystems report successful chmod without enforcing its mode.
      if (this.#verifyMode) this.#assertStagePermissions(fd);
      const assertBeforeMutation = this.#verifyMode ? () => {
        assertSynchronousCallbackResult(this.#assertBeforeMutation?.(), "assertBeforeMutation");
        fileSignal?.throwIfAborted();
        this.#assertStagePermissions(fd);
      } : this.#assertBeforeMutation;
      if (!copied) await writePinnedInput(fd, input, maxBytes, assertBeforeMutation);
      if (this.#verifyMode) this.#assertStagePermissions(fd);
      if (this.#sync) {
        if (this.#strictFileSync) fs.fsyncSync(fd);
        else syncFileBestEffortSync(fd);
      }
      const stat = fs.fstatSync(fd, { bigint: true });
      this.#receipt = createStagedFileReceipt(this.#directory, this.#name, stat);
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
      if (this.#assertBeforeMutation) {
        this.#assertCurrent();
        assertFinalSymlinkRejected(path.join(this.#directory.realPath, basename), this.#rejectFinalSymlink);
      }
      try {
        if (overwrite) {
          this.#binding.renameReplace(this.#parentFd, this.#name, this.#parentFd, basename);
        } else {
          this.#binding.renameNoReplace(this.#parentFd, this.#name, this.#parentFd, basename);
        }
      } catch (error) {
        // Only explicit pre-dispatch provenance can rule out a committed rename.
        if (classifyNativeRenameFailure(error) === "indeterminate") {
          state.publication = Object.freeze({ status: "indeterminate", basename, overwrite });
        }
        throw error;
      }
      return this.#completePublication(basename, overwrite, onPublished);
    } catch (error) {
      if (error instanceof MutationAuthorityError) throw error;
      // Closure rejects further use, not the recorded outcome of an earlier publication.
      const publication = this.#state.status === "closed"
        ? this.#state.receipt.publication
        : this.#state.publication;
      throw failure(error, { phase: "publish", publication });
    }
  }

  #completePublication(basename: string, overwrite: boolean, onPublished?: PinnedWriteParams["onPublished"]): PublishedFileReceipt {
    // Record complete content before fallible post-publication verification.
    const receipt: PublishedFileReceipt = Object.freeze({ status: "published", staged: this.receipt, basename, overwrite });
    this.#open().publication = receipt;
    onPublished?.(receipt.staged.identity);
    const stagedMode = this.#assertNamed(basename, 0o600);
    assertStagedDirectoryCurrent(this.#directory);
    // Keep contents private until the name passes its identity fence. Mode
    // changes use the owned fd, including for final mode 000.
    const fd = this.#file();
    if (this.#publishedMode !== 0o600 || stagedMode !== 0o600) fs.fchmodSync(fd, this.#publishedMode);
    // Content was synced during preparation. A lost chmod leaves 0600, no wider
    // than modes retaining owner rw; restrictive modes still need a durable correction.
    if (this.#sync && ((this.#publishedMode & 0o600) !== 0o600 || (stagedMode & ~this.#publishedMode) !== 0)) {
      if (this.#strictFileSync) fs.fsyncSync(fd);
      else syncFileBestEffortSync(fd);
    }
    if (this.#sync) syncFileBestEffortSync(this.#parentFd);
    this.#assertNamed(basename, this.#publishedMode);
    assertStagedDirectoryCurrent(this.#directory);
    return receipt;
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
    for (const [fd, closeFd] of [
      [state.fileFd, this.#closeFd],
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

export type {
  PublishedFileReceipt, StagedFile, StagedFileCleanupReceipt, StagedFileFailureDetails,
  StagedFilePublication, StagedFileReceipt,
} from "./staged-file-types.js";

export async function stageFileInDirectory(options: {
  directory: string | DirectoryReceipt<Stats | BigIntStats>;
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
  return await createNativeStage(
    binding, parent.fd, fs.closeSync, parent.receipt, input, mode,
    undefined, true, true, undefined, undefined, false, "mode-only",
  );
}
