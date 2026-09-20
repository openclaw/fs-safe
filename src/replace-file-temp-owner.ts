import syncFs, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createAsyncDirectoryGuard } from "./directory-guard.js";
import { hasErrorCode, removeOwnedPath } from "./file-cleanup.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup, sha256Hex } from "./file-identity.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";

type AsyncOwnerFileSystem = Pick<typeof fs, "lstat" | "open" | "unlink">;
type SyncOwnerFileSystem = Pick<
  typeof syncFs,
  "closeSync" | "fstatSync" | "lstatSync" | "openSync" | "readFileSync" | "unlinkSync"
>;

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

async function cleanupOwnedPath(params: {
  fsModule: AsyncOwnerFileSystem;
  pathname: string;
  identity?: BigIntStats;
  originalFailure?: AtomicTempFailure;
  throwOnCleanupError: boolean;
}): Promise<boolean> {
  try {
    await removeOwnedPath(params);
    return true;
  } catch (cleanupError) {
    if (params.throwOnCleanupError) {
      throw cleanupFailure(params.originalFailure, cleanupError);
    }
    return false;
  }
}

function cleanupOwnedPathSync(params: {
  fsModule: SyncOwnerFileSystem;
  pathname: string;
  identity?: BigIntStats;
  originalFailure?: AtomicTempFailure;
  throwOnCleanupError: boolean;
}): boolean {
  if (!params.identity) return true;
  try {
    const current = params.fsModule.lstatSync(params.pathname, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1n ||
      !sameFileIdentityForCleanup(current, params.identity)
    ) {
      return true;
    }
    params.fsModule.unlinkSync(params.pathname);
    return true;
  } catch (cleanupError) {
    if (hasErrorCode(cleanupError, "ENOENT")) return true;
    if (params.throwOnCleanupError) {
      throw cleanupFailure(params.originalFailure, cleanupError);
    }
    return false;
  }
}

class AtomicTempOwner<Resource> {
  readonly pathname: string;
  protected resource: Resource | undefined;
  protected recordedIdentity: BigIntStats | undefined;
  protected exists = false;
  protected unregister: TempPathRegistration;

  constructor(pathname: string) {
    this.pathname = pathname;
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

  protected takeResource(): Resource | undefined {
    // A throwing close may already have released the descriptor for reuse.
    const resource = this.resource;
    this.resource = undefined;
    return resource;
  }
}

export class AsyncAtomicTempOwner extends AtomicTempOwner<FileHandle> {
  adopt(temp: { handle: FileHandle; identity: BigIntStats }): void {
    this.resource = temp.handle;
    this.onIdentity(temp.identity);
  }

  async assertCurrent(fsModule: AsyncOwnerFileSystem, pathname = this.pathname): Promise<void> {
    const opened = await inspectFileIdentity(async () => {
      const stat = fsModule === fs ? syncFs.fstatSync(this.resource!.fd, { bigint: true })
        : await this.resource!.stat({ bigint: true });
      assertOwnedFile(stat, pathname, false);
      return stat;
    }, this.identity);
    try {
      await inspectFileIdentity(async () => {
        const stat = fsModule === fs ? syncFs.lstatSync(pathname, { bigint: true })
          : await fsModule.lstat(pathname, { bigint: true });
        assertOwnedFile(stat, pathname, true);
        return stat;
      }, opened);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        throw missingOwnedFile(pathname, error);
      }
      throw error;
    }
  }

  async assertPublished(
    fsModule: AsyncOwnerFileSystem,
    pathname: string,
    expectedHash?: string,
  ): Promise<void> {
    try {
      await this.assertCurrent(fsModule, pathname);
      return;
    } catch (error) {
      if (!(error instanceof FsSafeError) || !hasErrorCode(error, "path-mismatch") || !expectedHash) {
        throw error;
      }
    }

    let published: FileHandle | undefined;
    try {
      try {
        published = await fsModule.open(pathname, PUBLISHED_READ_FLAGS);
      } catch (error) {
        if (hasErrorCode(error, "ELOOP")) {
          throw new FsSafeError("symlink", `Atomic replace published file became a symlink: ${pathname}`, {
            cause: error,
          });
        }
        throw error;
      }
      const identity = await inspectFileIdentity(async () => {
        const stat = fsModule === fs ? syncFs.fstatSync(published!.fd, { bigint: true })
          : await published!.stat({ bigint: true });
        assertOwnedFile(stat, pathname, false);
        return stat;
      });
      await inspectFileIdentity(async () => {
        const stat = fsModule === fs ? syncFs.lstatSync(pathname, { bigint: true })
          : await fsModule.lstat(pathname, { bigint: true });
        assertOwnedFile(stat, pathname, true);
        return stat;
      }, identity);
      if (sha256Hex(await published.readFile()) !== expectedHash) {
        throw new FsSafeError("path-mismatch", `Atomic replace published content changed: ${pathname}`);
      }
      const previousHandle = this.takeResource();
      await previousHandle?.close();
      this.resource = published;
      this.recordedIdentity = identity;
      published = undefined;
    } finally {
      await published?.close().catch(() => undefined);
    }
  }

  async finish(params: {
    fsModule: AsyncOwnerFileSystem;
    originalFailure?: AtomicTempFailure;
    throwOnCleanupError: boolean;
  }): Promise<void> {
    let deferredFailure: AtomicTempFailure | undefined;
    let cleanupComplete = !this.exists;
    if (this.exists) {
      try {
        cleanupComplete = await cleanupOwnedPath({
          fsModule: params.fsModule,
          pathname: this.pathname,
          identity: this.recordedIdentity,
          originalFailure: params.originalFailure,
          throwOnCleanupError: params.throwOnCleanupError,
        });
      } catch (error) {
        deferredFailure = { error };
      }
    }
    if (cleanupComplete) this.unregister();
    const handle = this.takeResource();
    try {
      await handle?.close();
    } catch (closeError) {
      deferredFailure = closeFailure(closeError, params, deferredFailure);
    }
    if (deferredFailure) throw deferredFailure.error;
  }
}

export class SyncAtomicTempOwner extends AtomicTempOwner<number> {
  adopt(temp: { fd: number; identity: BigIntStats }): void {
    this.resource = temp.fd;
    this.onIdentity(temp.identity);
  }

  assertCurrent(fsModule: SyncOwnerFileSystem, pathname = this.pathname): void {
    const opened = inspectFileIdentitySync(() => {
      const stat = fsModule.fstatSync(this.resource!, { bigint: true });
      assertOwnedFile(stat, pathname, false);
      return stat;
    }, this.identity);
    try {
      inspectFileIdentitySync(() => {
        const stat = fsModule.lstatSync(pathname, { bigint: true });
        assertOwnedFile(stat, pathname, true);
        return stat;
      }, opened);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        throw missingOwnedFile(pathname, error);
      }
      throw error;
    }
  }

  assertPublished(
    fsModule: SyncOwnerFileSystem,
    pathname: string,
    expectedHash?: string,
  ): void {
    try {
      this.assertCurrent(fsModule, pathname);
      return;
    } catch (error) {
      if (!(error instanceof FsSafeError) || !hasErrorCode(error, "path-mismatch") || !expectedHash) {
        throw error;
      }
    }

    let publishedFd: number | undefined;
    try {
      try {
        publishedFd = fsModule.openSync(pathname, PUBLISHED_READ_FLAGS);
      } catch (error) {
        if (hasErrorCode(error, "ELOOP")) {
          throw new FsSafeError("symlink", `Atomic replace published file became a symlink: ${pathname}`, {
            cause: error,
          });
        }
        throw error;
      }
      const identity = inspectFileIdentitySync(() => {
        const stat = fsModule.fstatSync(publishedFd!, { bigint: true });
        assertOwnedFile(stat, pathname, false);
        return stat;
      });
      inspectFileIdentitySync(() => {
        const stat = fsModule.lstatSync(pathname, { bigint: true });
        assertOwnedFile(stat, pathname, true);
        return stat;
      }, identity);
      if (sha256Hex(fsModule.readFileSync(publishedFd)) !== expectedHash) {
        throw new FsSafeError("path-mismatch", `Atomic replace published content changed: ${pathname}`);
      }
      const previousFd = this.takeResource()!;
      fsModule.closeSync(previousFd);
      this.resource = publishedFd;
      this.recordedIdentity = identity;
      publishedFd = undefined;
    } finally {
      if (publishedFd !== undefined) {
        try {
          fsModule.closeSync(publishedFd);
        } catch {
          // Best-effort close after a rejected content verification.
        }
      }
    }
  }

  finish(params: {
    fsModule: SyncOwnerFileSystem;
    originalFailure?: AtomicTempFailure;
    throwOnCleanupError: boolean;
  }): void {
    let deferredFailure: AtomicTempFailure | undefined;
    let cleanupComplete = !this.exists;
    if (this.exists) {
      try {
        cleanupComplete = cleanupOwnedPathSync({
          fsModule: params.fsModule,
          pathname: this.pathname,
          identity: this.recordedIdentity,
          originalFailure: params.originalFailure,
          throwOnCleanupError: params.throwOnCleanupError,
        });
      } catch (error) {
        deferredFailure = { error };
      }
    }
    if (cleanupComplete) this.unregister();
    const fd = this.takeResource();
    if (fd !== undefined) {
      try {
        params.fsModule.closeSync(fd);
      } catch (closeError) {
        deferredFailure = closeFailure(closeError, params, deferredFailure);
      }
    }
    if (deferredFailure) throw deferredFailure.error;
  }
}
