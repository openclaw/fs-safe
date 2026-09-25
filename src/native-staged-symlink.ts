import fs, { type BigIntStats, type Stats } from "node:fs";
import type { DirectoryReceipt } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { captureNativeFdClose, type NativeBinding } from "./native-binding.js";
import { requireNativeBinding } from "./native.js";
import { classifyNativeRenameFailure } from "./native-rename-outcome.js";
import { assertStagedDirectoryCurrent, openStagedDirectory } from "./staged-directory.js";
import { createStagedFileReceipt } from "./staged-file-settlement.js";
import type {
  PublishedSymlinkReceipt, StagedSymlink, StagedSymlinkCleanupReceipt,
  StagedSymlinkExpected, StagedSymlinkFailureDetails, StagedSymlinkPublication,
  StagedSymlinkReceipt, StagedSymlinkRemoval,
} from "./staged-symlink-types.js";

type Binding = NativeBinding & Required<Pick<NativeBinding,
  "openStagedSymlink" | "stagedSymlinkTarget" | "stagedSymlinkMatches" |
  "publishStagedSymlink" | "removeStagedSymlink"
>>;
const NOT_PUBLISHED = Object.freeze({ status: "not-published" as const });

function basename(name: string): void {
  if (typeof name !== "string" || !name || name === "." || name === ".." ||
    /[/\\:\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(name)) {
    throw new FsSafeError("invalid-path", "staged symlinks require a direct-child basename");
  }
}

function failure(error: unknown, details: StagedSymlinkFailureDetails): FsSafeError {
  let code: FsSafeError["code"] = "helper-failed";
  try {
    code = error instanceof FsSafeError ? error.code
      : (error as NodeJS.ErrnoException)?.code === "EEXIST" ? "already-exists" : "helper-failed";
  } catch {
    // Uninspectable error metadata must not interrupt terminal settlement.
  }
  return new FsSafeError(code, `staged symlink ${details.phase} failed`, { cause: error, details });
}

function assertAuthority(assertion: () => void): void {
  assertSynchronousCallbackResult(assertion(), "assertBeforeMutation");
}

function expectedIdentity(stat: BigIntStats, expected: StagedSymlinkExpected): boolean {
  return stat.isSymbolicLink() && stat.nlink === 1n &&
    stat.dev === expected.dev && stat.ino === expected.ino &&
    stat.uid === BigInt(expected.uid) && stat.gid === BigInt(expected.gid) &&
    stat.ctimeNs === expected.ctimeNs;
}

class NativeStagedSymlink implements StagedSymlink {
  #publication: StagedSymlinkPublication = NOT_PUBLISHED;
  #closed?: { receipt: StagedSymlinkCleanupReceipt; error?: FsSafeError };
  #removal?: { receipt?: StagedSymlinkRemoval; error?: FsSafeError };

  #busy = false;
  readonly #receipt: StagedSymlinkReceipt;
  readonly #binding: Binding;
  readonly #parentFd: number;
  readonly #linkFd: number;
  readonly #closeLink: (fd: number) => void;
  readonly #assertion: () => void;

  constructor(receipt: StagedSymlinkReceipt, binding: Binding, parentFd: number,
    linkFd: number, closeLink: (fd: number) => void, assertion: () => void) {
    this.#receipt = receipt;
    this.#binding = binding;
    this.#parentFd = parentFd;
    this.#linkFd = linkFd;
    this.#closeLink = closeLink;
    this.#assertion = assertion;
  }

  get receipt(): StagedSymlinkReceipt { return this.#receipt; }

  #idle(): void {
    if (this.#busy) throw new FsSafeError("helper-failed", "reentrant symlink operation");
  }

  #open(): void {
    if (this.#closed) throw new FsSafeError("helper-failed", "staged symlink is closed");
  }

  #matches(name: string): boolean {
    if (!this.#binding.stagedSymlinkMatches(this.#parentFd, name, this.#linkFd)) return false;
    const stat = fs.fstatSync(this.#linkFd, { bigint: true });
    const identity = this.#receipt.identity;
    // ctime changes on rename; identity, ownership, mode and target do not.
    return stat.dev === identity.dev && stat.ino === identity.ino &&
      stat.uid === BigInt(identity.uid) && stat.gid === BigInt(identity.gid) &&
      Number(stat.mode & 0o7777n) === identity.mode && stat.nlink === 1n &&
      this.#binding.stagedSymlinkTarget(this.#parentFd, name, this.#linkFd) === this.#receipt.target;
  }

  #assertNamed(name: string): void {
    if (!this.#matches(name)) throw new FsSafeError("path-mismatch", "symlink no longer names the retained object");
  }

  #assertCurrent(): void {
    this.#open();
    if (this.#publication.status !== "not-published") {
      throw new FsSafeError("helper-failed", "symlink publication has already been attempted");
    }
    assertStagedDirectoryCurrent(this.#receipt.directory);
    this.#assertNamed(this.#receipt.temporaryBasename);
  }

  async assertCurrent(): Promise<void> { this.#idle(); this.#assertCurrent(); }

  async publish(name: string): Promise<PublishedSymlinkReceipt> {
    this.#idle();
    this.#busy = true;
    try {
      basename(name);
      if (name === this.#receipt.temporaryBasename) {
        throw new FsSafeError("invalid-path", "publication requires a distinct basename");
      }
      this.#assertCurrent();
      assertAuthority(this.#assertion);
      // A synchronous caller assertion can itself change either pathname.
      this.#assertCurrent();
      try {
        this.#binding.publishStagedSymlink(this.#parentFd, this.#receipt.temporaryBasename, this.#linkFd, name);
      } catch (error) {
        let outcome = "indeterminate";
        try { outcome = classifyNativeRenameFailure(error); } catch {
          // Unreadable diagnostics cannot prove that the rename was uncommitted.
        }
        if (outcome === "indeterminate") {
          this.#publication = Object.freeze({ status: "indeterminate", basename: name, overwrite: false });
        }
        throw error;
      }
      const published = Object.freeze({
        status: "published" as const, staged: this.#receipt, basename: name, overwrite: false as const,
      });
      // Record dispatch success before any fallible post-observation.
      this.#publication = published;
      this.#assertNamed(name);
      assertStagedDirectoryCurrent(this.#receipt.directory);
      return published;
    } catch (error) {
      throw failure(error, { phase: "publish", publication: this.#publication });
    } finally { this.#busy = false; }
  }

  #publishedName(): string {
    this.#open();
    if (this.#publication.status !== "published" || this.#removal) {
      throw new FsSafeError("helper-failed", "no unsettled published symlink");
    }
    return this.#publication.basename;
  }

  async assertPublished(): Promise<void> {
    this.#idle();
    const name = this.#publishedName();
    assertStagedDirectoryCurrent(this.#receipt.directory);
    this.#assertNamed(name);
  }

  #remove(name: string): StagedSymlinkRemoval {
    try {
      if (!this.#matches(name)) return "preserved";
    } catch (error) {
      let missing = false;
      try { missing = (error as NodeJS.ErrnoException)?.code === "ENOENT"; } catch {
        // Even a failed errno inspection must retain the original cause.
      }
      if (missing) return "name-absent";
      throw error;
    }
    assertAuthority(this.#assertion);
    // Recheck after application code and immediately before guarded native unlink.
    if (!this.#matches(name)) return "preserved";
    return this.#binding.removeStagedSymlink(this.#parentFd, name, this.#linkFd);
  }

  async removePublished(): Promise<StagedSymlinkRemoval> {
    this.#idle();
    this.#open();
    if (this.#removal) {
      if (this.#removal.error) throw this.#removal.error;
      return this.#removal.receipt!;
    }
    const name = this.#publishedName();
    this.#busy = true;
    try {
      const receipt = this.#remove(name);
      this.#removal = { receipt };
      return receipt;
    } catch (error) {
      const wrapped = failure(error, { phase: "remove-published", publication: this.#publication });
      // A failed unlink is not safe to retry automatically.
      this.#removal = { error: wrapped };
      throw wrapped;
    } finally { this.#busy = false; }
  }

  async cleanup(): Promise<StagedSymlinkCleanupReceipt> {
    this.#idle();
    if (this.#closed) {
      if (this.#closed.error) throw this.#closed.error;
      return this.#closed.receipt;
    }
    this.#busy = true;
    let status: StagedSymlinkCleanupReceipt["status"] = "not-needed";
    const errors: unknown[] = [];
    if (this.#publication.status === "indeterminate") status = "preserved";
    else if (this.#publication.status === "not-published") {
      try { status = this.#remove(this.#receipt.temporaryBasename); }
      catch (error) { status = "failed"; errors.push(error); }
    }
    let resources: StagedSymlinkCleanupReceipt["resources"] = "closed";
    for (const close of [() => this.#closeLink(this.#linkFd), () => fs.closeSync(this.#parentFd)]) {
      try { close(); } catch (error) { resources = "close-failed"; errors.push(error); }
    }
    const receipt = Object.freeze({
      temporaryBasename: this.#receipt.temporaryBasename,
      publication: this.#publication, status, resources,
    });
    const error = errors.length ? failure(
      errors.length === 1 ? errors[0] : new AggregateError(errors, "symlink settlement failed"),
      { phase: "cleanup", publication: this.#publication, cleanup: receipt },
    ) : undefined;
    this.#closed = { receipt, error };
    this.#busy = false;
    if (error) throw error;
    return receipt;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const cleanup = await this.cleanup();
    if (cleanup.status === "preserved") {
      throw new FsSafeError("not-removable", "symlink settlement preserved an unverified entry", {
        details: { phase: "cleanup", publication: this.#publication, cleanup } satisfies StagedSymlinkFailureDetails,
      });
    }
  }
}

/**
 * Admit an existing staged symlink against caller-captured identity and retain
 * its no-follow descriptor. Admission never creates, adopts by target, or unlinks.
 */
export async function retainSymlinkInDirectory(options: {
  directory: string | DirectoryReceipt<Stats | BigIntStats>;
  basename: string;
  expected: StagedSymlinkExpected;
  assertBeforeMutation: () => void;
}): Promise<StagedSymlink> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new FsSafeError("unsupported-platform", "retained symlinks require Linux or macOS");
  }
  const native = requireNativeBinding();
  if ([
    native.closeOwnedFd, native.openStagedSymlink, native.stagedSymlinkTarget,
    native.stagedSymlinkMatches, native.publishStagedSymlink, native.removeStagedSymlink,
  ].some((fn) => typeof fn !== "function")) {
    throw new FsSafeError("helper-unavailable", "native retained symlink support is unavailable");
  }
  const binding = native as Binding;
  const name = options.basename;
  basename(name);
  const expected = Object.freeze({ ...options.expected });
  const assertion = options.assertBeforeMutation;
  if (typeof assertion !== "function" || typeof expected.dev !== "bigint" ||
    typeof expected.ino !== "bigint" || typeof expected.ctimeNs !== "bigint" ||
    !Number.isSafeInteger(expected.uid) || expected.uid < 0 ||
    !Number.isSafeInteger(expected.gid) || expected.gid < 0 ||
    typeof expected.target !== "string" || !expected.target || expected.target.includes("\0")) {
    throw new FsSafeError("invalid-path", "exact symlink identity, target and synchronous authority are required");
  }
  const closeLink = captureNativeFdClose(binding);
  const parent = openStagedDirectory(options.directory);
  let fd: number | undefined;
  try {
    fd = binding.openStagedSymlink(parent.fd, name);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!expectedIdentity(stat, expected) ||
      binding.stagedSymlinkTarget(parent.fd, name, fd) !== expected.target) {
      throw new FsSafeError("path-mismatch", "staged symlink does not match the supplied identity");
    }
    const receipt = Object.freeze({
      ...createStagedFileReceipt(parent.receipt, name, stat), target: expected.target,
    });
    assertAuthority(assertion);
    const owner = new NativeStagedSymlink(receipt, binding, parent.fd, fd, closeLink, assertion);
    await owner.assertCurrent();
    return owner;
  } catch (error) {
    const errors = [error];
    for (const close of [() => { if (fd !== undefined) closeLink(fd); }, () => fs.closeSync(parent.fd)]) {
      try { close(); } catch (closeError) { errors.push(closeError); }
    }
    // Until admission succeeds, the caller retains every namespace cleanup duty.
    throw failure(errors.length === 1 ? error : new AggregateError(errors, "symlink admission and close failed"),
      { phase: "prepare", publication: NOT_PUBLISHED });
  }
}
