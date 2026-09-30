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
  ): Procedure<BigIntStats> {
    return inspectAtomicIdentity(this.io, read, expected, false,
      stat => assertOwnedFile(stat, pathname, pathnameEntry));
  }

  *assertCurrent(pathname = this.pathname): Procedure<void> {
    const opened = yield* this.inspectOwned(() => this.resource!.statExact(), pathname, false, this.identity);
    try {
      yield* this.inspectOwned(() => this.io.lstatExact(pathname), pathname, true, opened);
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
      const identity = yield* this.inspectOwned(() => published!.statExact(), pathname, false);
      yield* this.inspectOwned(() => this.io.lstatExact(pathname), pathname, true, identity);
      if (sha256Hex(yield* published.readFile()) !== expectedHash) {
        throw new FsSafeError("path-mismatch", `Atomic replace published content changed: ${pathname}`);
      }
      onVerified?.(identity);
      const previous = this.takeResource();
      if (previous) yield* previous.close();
      this.resource = published;
      this.recordedIdentity = identity;
      published = undefined;
    } finally {
      try {
        if (published) yield* published.close();
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
      if (file) yield* file.close();
    } catch (closeError) {
      deferredFailure = closeFailure(closeError, params, deferredFailure);
    }
    if (deferredFailure) throw deferredFailure.error;
  }
}
