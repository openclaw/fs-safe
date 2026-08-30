import syncFs, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";

type AsyncOwnerFileSystem = Pick<typeof fs, "lstat" | "unlink">;
type SyncOwnerFileSystem = Pick<
  typeof syncFs,
  "closeSync" | "fstatSync" | "lstatSync" | "unlinkSync"
>;

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

export class AsyncAtomicTempOwner {
  readonly pathname: string;
  #handle: FileHandle | undefined;
  #identity: BigIntStats | undefined;
  #exists = false;
  #unregister: TempPathRegistration;

  constructor(pathname: string) {
    this.pathname = pathname;
    this.#unregister = registerTempPathForExit(pathname, { singleLinkFile: true });
  }

  start(): void {
    this.#exists = true;
  }

  readonly onIdentity = (identity: BigIntStats): void => {
    this.#identity = identity;
    this.#unregister.setIdentity(identity);
  };

  adopt(temp: { handle: FileHandle; identity: BigIntStats }): void {
    this.#handle = temp.handle;
    this.onIdentity(temp.identity);
  }

  get identity(): BigIntStats {
    if (!this.#identity) throw new Error("Atomic temp owner has no identity");
    return this.#identity;
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

  markRenamed(): void {
    this.#exists = false;
    this.#unregister();
  }

  async finish(params: {
    fsModule: AsyncOwnerFileSystem;
    originalError?: unknown;
    throwOnCleanupError: boolean;
  }): Promise<void> {
    let deferredError: unknown;
    let cleanupComplete = !this.#exists;
    if (this.#exists) {
      try {
        cleanupComplete = await cleanupOwnedPath({
          fsModule: params.fsModule,
          pathname: this.pathname,
          identity: this.#identity,
          originalError: params.originalError,
          throwOnCleanupError: params.throwOnCleanupError,
        });
      } catch (error) {
        deferredError = error;
      }
    }
    if (cleanupComplete) this.#unregister();
    try {
      await this.#handle?.close();
    } catch (closeError) {
      deferredError = deferredError
        ? new AggregateError([deferredError, closeError], "Atomic temp cleanup and close failed")
        : params.originalError !== undefined
          ? new AggregateError(
              [params.originalError, closeError],
              "Atomic file replace and close failed",
            )
          : closeError;
    }
    if (deferredError) throw deferredError;
  }
}

export class SyncAtomicTempOwner {
  readonly pathname: string;
  #fd: number | undefined;
  #identity: BigIntStats | undefined;
  #exists = false;
  #unregister: TempPathRegistration;

  constructor(pathname: string) {
    this.pathname = pathname;
    this.#unregister = registerTempPathForExit(pathname, { singleLinkFile: true });
  }

  start(): void {
    this.#exists = true;
  }

  readonly onIdentity = (identity: BigIntStats): void => {
    this.#identity = identity;
    this.#unregister.setIdentity(identity);
  };

  adopt(temp: { fd: number; identity: BigIntStats }): void {
    this.#fd = temp.fd;
    this.onIdentity(temp.identity);
  }

  get identity(): BigIntStats {
    if (!this.#identity) throw new Error("Atomic temp owner has no identity");
    return this.#identity;
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

  markRenamed(): void {
    this.#exists = false;
    this.#unregister();
  }

  finish(params: {
    fsModule: SyncOwnerFileSystem;
    originalError?: unknown;
    throwOnCleanupError: boolean;
  }): void {
    let deferredError: unknown;
    let cleanupComplete = !this.#exists;
    if (this.#exists) {
      try {
        cleanupComplete = cleanupOwnedPathSync({
          fsModule: params.fsModule,
          pathname: this.pathname,
          identity: this.#identity,
          originalError: params.originalError,
          throwOnCleanupError: params.throwOnCleanupError,
        });
      } catch (error) {
        deferredError = error;
      }
    }
    if (cleanupComplete) this.#unregister();
    if (this.#fd !== undefined) {
      try {
        params.fsModule.closeSync(this.#fd);
      } catch (closeError) {
        deferredError = deferredError
          ? new AggregateError([deferredError, closeError], "Atomic temp cleanup and close failed")
          : params.originalError !== undefined
            ? new AggregateError(
                [params.originalError, closeError],
                "Atomic file replace and close failed",
              )
            : closeError;
      }
    }
    if (deferredError) throw deferredError;
  }
}
