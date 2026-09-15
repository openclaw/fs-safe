import fsSync from "node:fs";
import path from "node:path";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import type { TempWorkspaceRootAdmission } from "./temp-workspace-admission.js";

type DirectoryDescriptorAccess = "read" | "search";
type OpenedDirectory = { fd: number; access: DirectoryDescriptorAccess };

export type RetainedDirectory = {
  fd: number;
  access: DirectoryDescriptorAccess;
  receipt: Readonly<{
    path: string;
    realPath: string;
    identity: Readonly<{ dev: bigint; ino: bigint }>;
  }>;
};

export type RetainedChildDirectory = { fd: number };

function assertRetainedChildDirectory(stat: fsSync.BigIntStats): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new FsSafeError("not-file", "temp workspace child must be a real directory");
  }
}

function closeAfterAdmissionFailure(fd: number, error: unknown, message: string): never {
  try {
    fsSync.closeSync(fd);
  } catch (closeError) {
    throw new AggregateError([error, closeError], message);
  }
  throw error;
}

function openReadableDirectory(pathname: string): number {
  const flags = fsSync.constants.O_DIRECTORY | fsSync.constants.O_NOFOLLOW |
    fsSync.constants.O_NONBLOCK;
  return fsSync.openSync(pathname, fsSync.constants.O_RDONLY | flags);
}

function openRetainedDirectory(pathname: string): OpenedDirectory {
  try {
    return { fd: openReadableDirectory(pathname), access: "read" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    const route = nodeDirectorySearchOnlyFlags();
    if (!route) throw error;
    const flags = fsSync.constants.O_DIRECTORY | fsSync.constants.O_NOFOLLOW |
      fsSync.constants.O_NONBLOCK;
    return { fd: fsSync.openSync(pathname, route.flags | flags), access: "search" };
  }
}

export function openTempWorkspaceCleanupParent(
  root: string,
  admission: TempWorkspaceRootAdmission,
): RetainedDirectory {
  const pathname = path.resolve(root);
  if (pathname !== path.resolve(admission.dir)) {
    throw new FsSafeError("path-mismatch", "temp workspace cleanup parent differs from admitted root");
  }
  const opened = openRetainedDirectory(pathname);
  const { fd } = opened;
  try {
    // Observe the trusted name after acquiring the descriptor, then associate
    // the two exact identities within the same synchronous admission call.
    const observed = admission.associateCurrent(
      () => fsSync.fstatSync(fd, { bigint: true }),
    );
    if (path.resolve(observed.dir) !== pathname) {
      throw new FsSafeError("path-mismatch", "temp workspace cleanup parent changed while opening");
    }
    return {
      fd,
      access: opened.access,
      receipt: Object.freeze({
        path: pathname,
        realPath: observed.realPath,
        identity: Object.freeze({ dev: observed.stat.dev, ino: observed.stat.ino }),
      }),
    };
  } catch (error) {
    closeAfterAdmissionFailure(fd, error, "temp workspace cleanup parent admission and close failed");
  }
}

/** Owns the child descriptor until final admission transfers it to cleanup. */
export class TempWorkspaceRetainedChild {
  readonly #dir: string;
  readonly #identity: Readonly<{ dev: bigint; ino: bigint }>;
  #access: DirectoryDescriptorAccess;
  #fd: number | undefined;

  constructor(dir: string, identity: FileIdentityStat) {
    if (typeof identity.dev !== "bigint" || typeof identity.ino !== "bigint") {
      throw new FsSafeError("path-mismatch", "temp workspace child identity is incomplete");
    }
    this.#dir = dir;
    this.#identity = Object.freeze({ dev: identity.dev, ino: identity.ino });
    const descriptor = openRetainedDirectory(dir);
    const { fd } = descriptor;
    this.#access = descriptor.access;
    try {
      const openedStat = inspectFileIdentitySync(
        () => fsSync.fstatSync(fd, { bigint: true }),
        this.#identity,
      );
      assertRetainedChildDirectory(openedStat);
      this.#fd = fd;
    } catch (error) {
      closeAfterAdmissionFailure(fd, error, "temp workspace child admission and close failed");
    }
  }

  inspectCurrent(): fsSync.BigIntStats {
    if (this.#fd === undefined) {
      throw new FsSafeError("path-mismatch", "temp workspace child descriptor is unavailable");
    }
    const current = inspectFileIdentitySync(
      () => fsSync.fstatSync(this.#fd!, { bigint: true }),
      this.#identity,
    );
    assertRetainedChildDirectory(current);
    return current;
  }

  get canEnumerate(): boolean {
    return this.#access === "read";
  }

  ensureReadable(): boolean {
    if (this.canEnumerate) return true;
    if (this.#fd === undefined) {
      throw new FsSafeError("path-mismatch", "temp workspace child descriptor is unavailable");
    }
    let fd: number;
    try {
      fd = openReadableDirectory(this.#dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") return false;
      throw error;
    }
    try {
      const openedStat = inspectFileIdentitySync(
        () => fsSync.fstatSync(fd, { bigint: true }),
        this.#identity,
      );
      assertRetainedChildDirectory(openedStat);
    } catch (error) {
      closeAfterAdmissionFailure(fd, error, "temp workspace readable child admission and close failed");
    }

    // A failed close leaves descriptor ownership indeterminate. Relinquish the
    // old descriptor before closing it so factory cleanup never retries that fd.
    const previous = this.#fd;
    this.#fd = undefined;
    try {
      fsSync.closeSync(previous);
    } catch (error) {
      // The readable replacement has not been installed. Give it exactly one
      // close attempt and leave neither indeterminate descriptor owned here.
      try {
        fsSync.closeSync(fd);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "temp workspace child descriptor replacement close failed",
        );
      }
      throw error;
    }
    this.#fd = fd;
    this.#access = "read";
    return true;
  }

  transfer(retainDescriptor: boolean): {
    dir: string;
    identity: Readonly<{ dev: bigint; ino: bigint }>;
    directory: RetainedChildDirectory | undefined;
  } {
    if (this.#fd === undefined) {
      throw new FsSafeError("path-mismatch", "temp workspace child descriptor is unavailable");
    }
    const fd = this.#fd;
    this.#fd = undefined;
    if (retainDescriptor && !this.canEnumerate) {
      try {
        fsSync.closeSync(fd);
      } catch (closeError) {
        throw new AggregateError([
          new FsSafeError("helper-unavailable", "temp workspace cleanup requires a readable child descriptor"),
          closeError,
        ], "temp workspace child descriptor rejection and close failed");
      }
      throw new FsSafeError(
        "helper-unavailable",
        "temp workspace cleanup requires a readable child descriptor",
      );
    }
    if (!retainDescriptor) {
      fsSync.closeSync(fd);
      return { dir: this.#dir, identity: this.#identity, directory: undefined };
    }
    return { dir: this.#dir, identity: this.#identity, directory: { fd } };
  }

  close(): void {
    if (this.#fd === undefined) return;
    const fd = this.#fd;
    this.#fd = undefined;
    fsSync.closeSync(fd);
  }
}
