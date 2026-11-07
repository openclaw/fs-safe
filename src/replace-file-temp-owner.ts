import syncFs, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createAsyncDirectoryGuard } from "./directory-guard.js";
import { hasErrorCode } from "./file-cleanup.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup, sha256Hex } from "./file-identity.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { inspectAtomicIdentity, wait, type AtomicFile, type AtomicIo, type Procedure } from "./atomic-io.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";
import { admitsDrvfsRenameRecoveryAtFd, assertRecoveredPublication, shouldPrepareDrvfsRecovery } from "./publication-recovery.js";
import { retainDrvfsParent } from "./drvfs-parent.js";

const PUBLISHED_READ_FLAGS = resolveReadOpenFlags();

export type AtomicTempFailure = Readonly<{ error: unknown }>;

function describeFailure(error: unknown): string {
  try {
    return String(error);
  } catch {
    return "<unprintable failure>";
  }
}

function isErrorValue(error: unknown): error is Error {
  try {
    return error instanceof Error;
  } catch {
    return false;
  }
}

export async function removePathIfIdentityUnchanged(
  targetPath: string,
  identity: Pick<BigIntStats, "dev" | "ino">,
): Promise<void> {
  const parentGuard = await createAsyncDirectoryGuard(path.dirname(targetPath), { bigint: true });
  await withAsyncDirectoryGuards([parentGuard], async () => {
    const current = syncFs.lstatSync(targetPath, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile() || !sameFileIdentityForCleanup(current, identity)) return;
    await fs.unlink(targetPath);
  });
}

function assertOwnedFile(stat: BigIntStats, pathname: string, pathnameEntry: boolean): void {
  if (stat.isSymbolicLink()) {
    throw new FsSafeError("symlink", `Atomic replace owned file became a symlink: ${pathname}`);
  }
  if (!stat.isFile()) {
    throw new FsSafeError("not-file", `Atomic replace owned file must remain regular: ${pathname}`);
  }
  if (stat.nlink > 1n || (pathnameEntry && stat.nlink !== 1n)) {
    throw new FsSafeError("hardlink", `Atomic replace owned file must retain one link: ${pathname}`);
  }
}

function missingOwnedFile(pathname: string, cause: unknown): FsSafeError {
  return new FsSafeError("path-mismatch", `Atomic replace owned file disappeared: ${pathname}`, {
    cause,
  });
}

function cleanupFailure(
  originalFailure: AtomicTempFailure | undefined,
  cleanupError: unknown,
): Error {
  if (originalFailure) {
    return new Error(
      `Atomic file replace failed (${describeFailure(originalFailure.error)}); cleanup also failed (${describeFailure(cleanupError)})`,
      { cause: originalFailure.error },
    );
  }
  return isErrorValue(cleanupError) ? cleanupError : new Error(describeFailure(cleanupError));
}

function closeFailure(
  closeError: unknown,
  params: { originalFailure?: AtomicTempFailure },
  cleanupFailure?: AtomicTempFailure,
): AtomicTempFailure {
  return {
    error: cleanupFailure
      ? new AggregateError([cleanupFailure.error, closeError], "Atomic temp cleanup and close failed")
      : params.originalFailure
        ? new AggregateError([params.originalFailure.error, closeError], "Atomic file replace and close failed")
        : closeError,
  };
}

export class AtomicTempOwner {
  private resource: AtomicFile | undefined;
  private recordedIdentity: BigIntStats | undefined;
  private exists = false;
  private recoveryParent?: ReturnType<typeof retainDrvfsParent>;
  private recoveryIdentity?: BigIntStats;
  private recoveryContent?: Uint8Array;
  private recovered = false;
  private readonly unregister: TempPathRegistration;

  constructor(readonly pathname: string, private readonly io: AtomicIo) {
    this.unregister = registerTempPathForExit(pathname, { singleLinkFile: true });
  }

  start(): void {
    this.exists = true;
  }

  readonly onIdentity = (identity: BigIntStats): void => {
    this.recordedIdentity = identity;
    this.unregister.setIdentity(identity);
  };

  get identity(): BigIntStats {
    if (!this.recordedIdentity) throw new Error("Atomic temp owner has no identity");
    return this.recordedIdentity;
  }

  get canRecoverHiddenRename(): boolean {
    return this.recoveryParent !== undefined;
  }

  get fd(): number {
    if (!this.resource) throw new Error("Atomic temp owner has no descriptor");
    return this.resource.fd;
  }

  *prepareRecovery(content: string | Uint8Array): Procedure<void> {
    if (!shouldPrepareDrvfsRecovery(true)) return;
    this.recoveryParent = retainDrvfsParent(path.dirname(this.pathname));
    if (!this.recoveryParent) return;
    const observed = this.resource!.statExact();
    this.recoveryIdentity = (this.io.asynchronous ? yield observed : observed) as BigIntStats;
    this.recoveryContent = Buffer.from(content);
  }

  markRenamed(): void {
    this.exists = false;
    this.unregister();
  }

  private takeResource(): AtomicFile | undefined {
    // A throwing close may already have released the descriptor for reuse.
    const resource = this.resource;
    this.resource = undefined;
    return resource;
  }

  adopt(temp: { file: AtomicFile; identity: BigIntStats }): void {
    this.resource = temp.file;
    this.onIdentity(temp.identity);
  }

  private inspectOwned(
    read: () => BigIntStats | Promise<BigIntStats>,
    pathname: string,
    pathnameEntry: boolean,
    expected?: BigIntStats,
  ): BigIntStats | Promise<BigIntStats> {
    return inspectAtomicIdentity(this.io, read, expected, false,
      stat => assertOwnedFile(stat, pathname, pathnameEntry));
  }

  *assertCurrent(pathname = this.pathname): Procedure<void> {
    const openedInspection = this.inspectOwned(() => this.resource!.statExact(), pathname, false, this.identity);
    const opened = (this.io.asynchronous ? (yield openedInspection) : openedInspection) as BigIntStats;
    if (this.recovered) assertRecoveredPublication(opened, this.recoveryIdentity!);
    try {
      const currentInspection = this.inspectOwned(() => this.io.lstatExact(pathname), pathname, true, opened);
      const current = (this.io.asynchronous ? yield currentInspection : currentInspection) as BigIntStats;
      if (this.recovered) assertRecoveredPublication(current, this.recoveryIdentity!);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        throw missingOwnedFile(pathname, error);
      }
      throw error;
    }
  }

  *assertPublished(
    pathname: string,
    expectedHash?: string,
    onVerified?: (identity: BigIntStats) => void,
  ): Procedure<void> {
    let identityCurrent = false;
    try {
      yield* this.assertCurrent(pathname);
      identityCurrent = true;
    } catch (error) {
      if (this.recoveryParent && (hasErrorCode(error, "ENOENT") ||
        (error instanceof FsSafeError && hasErrorCode(error.cause, "ENOENT")))) {
        this.recoveryParent.assertCurrent();
        if (!admitsDrvfsRenameRecoveryAtFd(this.recoveryParent.fd)) throw error;
        const previous = this.takeResource()!;
        const closing = previous.close();
        if (this.io.asynchronous) yield closing;
        for (let attempt = 0; ; attempt++) {
          try {
            this.recoveryParent.assertCurrent();
            this.resource = yield* this.io.open(pathname, PUBLISHED_READ_FLAGS);
            yield* this.assertCurrent(pathname);
            const observed = this.resource.statExact();
            const stat = (this.io.asynchronous ? yield observed : observed) as BigIntStats;
            assertRecoveredPublication(stat, this.recoveryIdentity!);
            if (!Buffer.from(yield* this.resource.readFileBounded(this.recoveryContent!.byteLength)).equals(this.recoveryContent!)) {
              throw new FsSafeError("path-mismatch", "published content changed during DrvFS recovery");
            }
            yield* this.assertCurrent(pathname);
            this.recoveryParent.assertCurrent();
            this.recovered = true;
            onVerified?.(this.identity);
            return;
          } catch (recoveryError) {
            const failed = this.takeResource();
            if (failed) {
              const settled = failed.close();
              if (this.io.asynchronous) yield settled;
            }
            if (!hasErrorCode(recoveryError, "ENOENT") || attempt === 4) throw recoveryError;
            yield* this.io.delay(20);
          }
        }
      }
      if (!(error instanceof FsSafeError) || !hasErrorCode(error, "path-mismatch") || !expectedHash) {
        throw error;
      }
    }
    if (identityCurrent) {
      onVerified?.(this.identity);
      return;
    }

    let published: AtomicFile | undefined;
    try {
      try {
        published = yield* this.io.open(pathname, PUBLISHED_READ_FLAGS);
      } catch (error) {
        if (hasErrorCode(error, "ELOOP")) {
          throw new FsSafeError("symlink", `Atomic replace published file became a symlink: ${pathname}`, {
            cause: error,
          });
        }
        throw error;
      }
      const openedInspection = this.inspectOwned(() => published!.statExact(), pathname, false);
      const identity = (this.io.asynchronous ? (yield openedInspection) : openedInspection) as BigIntStats;
      const currentInspection = this.inspectOwned(() => this.io.lstatExact(pathname), pathname, true, identity);
      if (this.io.asynchronous) yield currentInspection;
      if (sha256Hex(yield* published.readFile()) !== expectedHash) {
        throw new FsSafeError("path-mismatch", `Atomic replace published content changed: ${pathname}`);
      }
      onVerified?.(identity);
      const previous = this.takeResource();
      const closing = previous?.close();
      if (previous && this.io.asynchronous) yield closing;
      this.resource = published;
      this.recordedIdentity = identity;
      published = undefined;
    } finally {
      try {
        const closing = published?.close();
        if (published && this.io.asynchronous) yield closing;
      } catch {
        // Preserve the selected verification or previous-resource close failure.
      }
    }
  }

  private *cleanupOwnedPath(params: {
    originalFailure?: AtomicTempFailure;
    throwOnCleanupError: boolean;
  }): Procedure<boolean> {
    const identity = this.recordedIdentity;
    if (!identity) return true;
    try {
      const observation = this.io.lstatExact(this.pathname);
      const current = this.io.asyncFs && this.io.asyncFs !== fs
        ? yield* wait(observation) : observation as BigIntStats;
      if (!current.isSymbolicLink() && current.isFile() && current.nlink === 1n &&
          sameFileIdentityForCleanup(current, identity)) {
        yield* this.io.unlink(this.pathname);
      }
      return true;
    } catch (cleanupError) {
      if (hasErrorCode(cleanupError, "ENOENT")) return true;
      if (params.throwOnCleanupError) {
        throw cleanupFailure(params.originalFailure, cleanupError);
      }
      return false;
    }
  }

  *finish(params: {
    originalFailure?: AtomicTempFailure;
    throwOnCleanupError: boolean;
  }): Procedure<void> {
    let deferredFailure: AtomicTempFailure | undefined;
    let cleanupComplete = !this.exists;
    if (this.exists) {
      try {
        cleanupComplete = yield* this.cleanupOwnedPath(params);
      } catch (error) {
        deferredFailure = { error };
      }
    }
    if (cleanupComplete) this.unregister();
    const file = this.takeResource();
    try {
      const closing = file?.close();
      if (file && this.io.asynchronous) yield closing;
    } catch (closeError) {
      deferredFailure = closeFailure(closeError, params, deferredFailure);
    }
    try { this.recoveryParent?.close(); }
    catch (error) { deferredFailure ??= { error }; }
    this.recoveryParent = undefined;
    if (deferredFailure) throw deferredFailure.error;
  }
}
