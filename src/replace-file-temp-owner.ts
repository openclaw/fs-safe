import syncFs, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { assertAsyncDirectoryGuard, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup, sha256Hex } from "./file-identity.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";

type AsyncOwnerFileSystem = Pick<typeof fs, "lstat" | "open" | "unlink">;
type SyncOwnerFileSystem = Pick<
  typeof syncFs,
  "closeSync" | "fstatSync" | "lstatSync" | "openSync" | "readFileSync" | "unlinkSync"
>;

const PUBLISHED_READ_FLAGS = resolveReadOpenFlags();

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

function cleanupFailure(originalError: unknown, cleanupError: unknown): Error {
  if (originalError !== undefined) {
    return new Error(
      `Atomic file replace failed (${String(originalError)}); cleanup also failed (${String(cleanupError)})`,
      { cause: originalError },
    );
  }
  return cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
}

function cleanupCloseError(deferredError: unknown, originalError: unknown, closeError: unknown): unknown {
  return deferredError
    ? new AggregateError([deferredError, closeError], "Atomic temp cleanup and close failed")
    : originalError !== undefined
      ? new AggregateError(
          [originalError, closeError],
          "Atomic file replace and close failed",
        )
      : closeError;
}

async function cleanupOwnedPath(params: {
  fsModule: AsyncOwnerFileSystem;
  pathname: string;
  identity?: BigIntStats;
  originalError?: unknown;
  throwOnCleanupError: boolean;
}): Promise<boolean> {
  if (!params.identity) return true;
  try {
    const current = await params.fsModule.lstat(params.pathname, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1n ||
      !sameFileIdentityForCleanup(current, params.identity)
    ) {
      return true;
    }
    await params.fsModule.unlink(params.pathname);
    return true;
  } catch (cleanupError) {
    if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") return true;
    if (params.throwOnCleanupError) {
      throw cleanupFailure(params.originalError, cleanupError);
    }
    return false;
  }
}

// Borrowed handle: the caller retains it until this best-effort cleanup finishes.
export async function cleanupPinnedFilePath(params: {
  pathname: string;
  handle: FileHandle;
  identity?: BigIntStats;
  parentGuard: AnyAsyncDirectoryGuard;
}): Promise<void> {
  if (!params.identity) return;
  try {
    const guard = params.parentGuard;
    if ([guard.stat.dev, guard.stat.ino].some(
      (value) => typeof value === "number" && !Number.isSafeInteger(value),
    )) return;
    await assertAsyncDirectoryGuard(guard);
    const parent = await fs.lstat(guard.dir, { bigint: true });
    if (parent.isSymbolicLink() || !parent.isDirectory() ||
      !sameFileIdentityForCleanup(parent, guard.stat)) return;
    const opened = await params.handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n ||
      !sameFileIdentityForCleanup(opened, params.identity)) return;
    await cleanupOwnedPath({
      fsModule: fs,
      pathname: params.pathname,
      identity: params.identity,
      throwOnCleanupError: false,
    });
  } catch {
    // Unverifiable authority must preserve the path and the original write failure.
  }
}

function cleanupOwnedPathSync(params: {
  fsModule: SyncOwnerFileSystem;
  pathname: string;
  identity?: BigIntStats;
  originalError?: unknown;
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
    if ((cleanupError as NodeJS.ErrnoException).code === "ENOENT") return true;
    if (params.throwOnCleanupError) {
      throw cleanupFailure(params.originalError, cleanupError);
    }
    return false;
  }
}

class AtomicTempOwnerState {
  readonly pathname: string;
  protected ownedIdentity: BigIntStats | undefined;
  protected exists = false;
  protected unregister: TempPathRegistration;

  constructor(pathname: string, unregister: TempPathRegistration) {
    this.pathname = pathname;
    this.unregister = unregister;
  }

  start(): void {
    this.exists = true;
  }

  readonly onIdentity = (identity: BigIntStats): void => {
    this.ownedIdentity = identity;
    this.unregister.setIdentity(identity);
  };

  get identity(): BigIntStats {
    if (!this.ownedIdentity) throw new Error("Atomic temp owner has no identity");
    return this.ownedIdentity;
  }

  markRenamed(): void {
    this.exists = false;
    this.unregister();
  }
}

export class AsyncAtomicTempOwner extends AtomicTempOwnerState {
  #handle: FileHandle | undefined;

  constructor(pathname: string) {
    super(pathname, registerTempPathForExit(pathname, { singleLinkFile: true }));
  }

  adopt(temp: { handle: FileHandle; identity: BigIntStats }): void {
    this.#handle = temp.handle;
    this.onIdentity(temp.identity);
  }

  async assertCurrent(fsModule: AsyncOwnerFileSystem, pathname = this.pathname): Promise<void> {
    const opened = await inspectFileIdentity(async () => {
      const stat = await this.#handle!.stat({ bigint: true });
      assertOwnedFile(stat, pathname, false);
      return stat;
    }, this.identity);
    try {
      await inspectFileIdentity(async () => {
        const stat = await fsModule.lstat(pathname, { bigint: true });
        assertOwnedFile(stat, pathname, true);
        return stat;
      }, opened);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
      if (!(error instanceof FsSafeError) || error.code !== "path-mismatch" || !expectedHash) {
        throw error;
      }
    }

    let published: FileHandle | undefined;
    try {
      try {
        published = await fsModule.open(pathname, PUBLISHED_READ_FLAGS);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
          throw new FsSafeError("symlink", `Atomic replace published file became a symlink: ${pathname}`, {
            cause: error,
          });
        }
        throw error;
      }
      const identity = await inspectFileIdentity(async () => {
        const stat = await published!.stat({ bigint: true });
        assertOwnedFile(stat, pathname, false);
        return stat;
      });
      await inspectFileIdentity(async () => {
        const stat = await fsModule.lstat(pathname, { bigint: true });
        assertOwnedFile(stat, pathname, true);
        return stat;
      }, identity);
      if (sha256Hex(await published.readFile()) !== expectedHash) {
        throw new FsSafeError("path-mismatch", `Atomic replace published content changed: ${pathname}`);
      }
      await this.#handle?.close();
      this.#handle = published;
      this.ownedIdentity = identity;
      published = undefined;
    } finally {
      await published?.close().catch(() => undefined);
    }
  }

  async finish(params: {
    fsModule: AsyncOwnerFileSystem;
    originalError?: unknown;
    throwOnCleanupError: boolean;
  }): Promise<void> {
    let deferredError: unknown;
    let cleanupComplete = !this.exists;
    if (this.exists) {
      try {
        cleanupComplete = await cleanupOwnedPath({
          fsModule: params.fsModule,
          pathname: this.pathname,
          identity: this.ownedIdentity,
          originalError: params.originalError,
          throwOnCleanupError: params.throwOnCleanupError,
        });
      } catch (error) {
        deferredError = error;
      }
    }
    if (cleanupComplete) this.unregister();
    try {
      await this.#handle?.close();
    } catch (closeError) {
      deferredError = cleanupCloseError(deferredError, params.originalError, closeError);
    }
    if (deferredError) throw deferredError;
  }
}

export class SyncAtomicTempOwner extends AtomicTempOwnerState {
  #fd: number | undefined;

  constructor(pathname: string) {
    super(pathname, registerTempPathForExit(pathname, { singleLinkFile: true }));
  }

  adopt(temp: { fd: number; identity: BigIntStats }): void {
    this.#fd = temp.fd;
    this.onIdentity(temp.identity);
  }

  assertCurrent(fsModule: SyncOwnerFileSystem, pathname = this.pathname): void {
    const opened = inspectFileIdentitySync(() => {
      const stat = fsModule.fstatSync(this.#fd!, { bigint: true });
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
      if (!(error instanceof FsSafeError) || error.code !== "path-mismatch" || !expectedHash) {
        throw error;
      }
    }

    let publishedFd: number | undefined;
    try {
      try {
        publishedFd = fsModule.openSync(pathname, PUBLISHED_READ_FLAGS);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOOP") {
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
      fsModule.closeSync(this.#fd!);
      this.#fd = publishedFd;
      this.ownedIdentity = identity;
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
    originalError?: unknown;
    throwOnCleanupError: boolean;
  }): void {
    let deferredError: unknown;
    let cleanupComplete = !this.exists;
    if (this.exists) {
      try {
        cleanupComplete = cleanupOwnedPathSync({
          fsModule: params.fsModule,
          pathname: this.pathname,
          identity: this.ownedIdentity,
          originalError: params.originalError,
          throwOnCleanupError: params.throwOnCleanupError,
        });
      } catch (error) {
        deferredError = error;
      }
    }
    if (cleanupComplete) this.unregister();
    if (this.#fd !== undefined) {
      try {
        params.fsModule.closeSync(this.#fd);
      } catch (closeError) {
        deferredError = cleanupCloseError(deferredError, params.originalError, closeError);
      }
    }
    if (deferredError) throw deferredError;
  }
}
