import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { assertOwnedDirectory } from "./directory-mode-owner.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import type { TempWorkspaceRootAdmission } from "./temp-workspace-admission.js";
import {
  inspectTempWorkspaceDescriptorIdentitySync,
  inspectTempWorkspaceDirectoryIdentitySync,
  projectTempWorkspaceNumericIdentity,
  type TempWorkspaceNumericIdentity,
  type TempWorkspaceIdentityStat,
} from "./temp-workspace-identity.js";

const LINUX = process.platform === "linux";

type DirectoryDescriptorAccess = "read" | "search";
type OpenedDirectory = {
  fd: number;
  access: DirectoryDescriptorAccess;
  proc: boolean;
};

type TempWorkspaceChildModeChecks = {
  assertParent(): void;
  hasRequestedMode(stat: TempWorkspaceIdentityStat): boolean;
  validate(stat: TempWorkspaceIdentityStat): void;
};

type InitialTempWorkspaceChildReceipt = Readonly<{ stat: fsSync.BigIntStats }>;

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

function assertRetainedChildDirectory(stat: TempWorkspaceIdentityStat): void {
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
    return { fd: openReadableDirectory(pathname), access: "read", proc: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    const route = nodeDirectorySearchOnlyFlags();
    if (!route) throw error;
    const flags = fsSync.constants.O_DIRECTORY | fsSync.constants.O_NOFOLLOW |
      fsSync.constants.O_NONBLOCK;
    return {
      fd: fsSync.openSync(pathname, route.flags | flags),
      access: "search",
      proc: route.proc,
    };
  }
}

function chmodDescriptor(fd: number, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsSync.fchmod(fd, mode, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
    // Existing canonical roots deliberately retain this descriptor
    // provisionally. Its exact association is completed at the native probe
    // (when present) and again with the full pre-mutation ancestry admission.
    // Guarded alias/missing-component routes retain their historical eager
    // association through the admission implementation.
    admission.retainCleanupParent(fd);
    return {
      fd,
      access: opened.access,
      receipt: Object.freeze({
        path: pathname,
        realPath: admission.realPath,
        identity: admission.identity,
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
  readonly #numericIdentity: TempWorkspaceNumericIdentity | undefined;
  #access: DirectoryDescriptorAccess;
  #fd: number | undefined;
  #modeLease = false;
  #proc: boolean;
  #transferAuthorized = false;
  #initialReceipt: InitialTempWorkspaceChildReceipt | undefined;

  private constructor(
    dir: string,
    identity: FileIdentityStat,
    descriptor: OpenedDirectory,
    initialReceipt?: InitialTempWorkspaceChildReceipt,
  ) {
    if (typeof identity.dev !== "bigint" || typeof identity.ino !== "bigint") {
      throw new FsSafeError("path-mismatch", "temp workspace child identity is incomplete");
    }
    this.#dir = dir;
    this.#identity = Object.freeze({ dev: identity.dev, ino: identity.ino });
    this.#numericIdentity = LINUX
      ? projectTempWorkspaceNumericIdentity(this.#identity)
      : undefined;
    this.#access = descriptor.access;
    this.#proc = descriptor.proc;
    // Opening without following the final component pins the child, but does
    // not admit it. Until final descriptor + name validation succeeds this
    // handle may only be inspected, mode-validated, replaced, or closed.
    this.#fd = descriptor.fd;
    this.#initialReceipt = initialReceipt;
  }

  static retain(dir: string, identity: FileIdentityStat): TempWorkspaceRetainedChild {
    if (typeof identity.dev !== "bigint" || typeof identity.ino !== "bigint") {
      throw new FsSafeError("path-mismatch", "temp workspace child identity is incomplete");
    }
    const descriptor = openRetainedDirectory(dir);
    try {
      return new TempWorkspaceRetainedChild(dir, identity, descriptor);
    } catch (error) {
      closeAfterAdmissionFailure(
        descriptor.fd,
        error,
        "temp workspace child admission and close failed",
      );
    }
  }

  static retainCreated(dir: string): {
    retained: TempWorkspaceRetainedChild;
    stat: fsSync.BigIntStats;
  } {
    const descriptor = openRetainedDirectory(dir);
    try {
      // Only this immediate post-create route installs a receipt. Freezing the
      // exact fd result keeps its identity and complete mode immutable while
      // the synchronous caller validates it and decides whether to correct.
      const stat = fsSync.fstatSync(descriptor.fd, { bigint: true });
      Object.freeze(stat);
      const receipt = Object.freeze({ stat });
      return {
        retained: new TempWorkspaceRetainedChild(dir, stat, descriptor, receipt),
        stat,
      };
    } catch (error) {
      closeAfterAdmissionFailure(
        descriptor.fd,
        error,
        "temp workspace created child admission and close failed",
      );
    }
  }

  discardInitialReceipt(): void {
    this.#initialReceipt = undefined;
  }

  #consumeInitialReceipt(): fsSync.BigIntStats | undefined {
    const receipt = this.#initialReceipt;
    // Clear first so validation failures, procfs checks, and later admission
    // can never reuse the creation observation.
    this.#initialReceipt = undefined;
    return receipt?.stat;
  }

  finalizeAdmission(
    validate: (stat: TempWorkspaceIdentityStat) => void,
  ): TempWorkspaceIdentityStat {
    this.#assertModeLeaseReleased();
    this.discardInitialReceipt();
    if (this.#fd === undefined) {
      throw new FsSafeError("path-mismatch", "temp workspace child descriptor is unavailable");
    }
    // A failed revalidation must never leave an earlier receipt transferable.
    this.#transferAuthorized = false;
    const current = inspectTempWorkspaceDescriptorIdentitySync(
      this.#fd,
      this.#identity,
      this.#numericIdentity,
    );
    assertRetainedChildDirectory(current);
    validate(current);
    const named = inspectTempWorkspaceDirectoryIdentitySync(
      this.#dir,
      this.#identity,
      this.#numericIdentity,
    );
    validate(named);
    this.#transferAuthorized = true;
    return named;
  }

  #assertModeLeaseReleased(): void {
    if (this.#modeLease) {
      throw new FsSafeError("path-mismatch", "temp workspace child mode operation is active");
    }
  }

  #inspectModeTarget(
    fd: number,
    validate: (stat: TempWorkspaceIdentityStat) => void,
    initial?: fsSync.BigIntStats,
  ): TempWorkspaceIdentityStat {
    const descriptor = initial ?? inspectTempWorkspaceDescriptorIdentitySync(
      fd, this.#identity, this.#numericIdentity,
    );
    assertRetainedChildDirectory(descriptor);
    validate(descriptor);
    const named = inspectTempWorkspaceDirectoryIdentitySync(
      this.#dir,
      this.#identity,
      this.#numericIdentity,
    );
    validate(named);
    return descriptor;
  }

  async #assertProcAuthority(
    fd: number,
    validate: (stat: fsSync.BigIntStats) => void,
  ): Promise<void> {
    if ((await fs.statfs("/proc/self/fd", { bigint: true })).type !== 0x9fa0n) {
      throw new FsSafeError("path-mismatch", "directory mode requires a trusted procfs fd namespace");
    }
    const procPath = `/proc/self/fd/${fd}`;
    const opened = inspectFileIdentitySync(
      () => fsSync.fstatSync(fd, { bigint: true }),
      this.#identity,
    );
    const followed = inspectFileIdentitySync(
      () => fsSync.statSync(procPath, { bigint: true }),
      this.#identity,
    );
    assertOwnedDirectory(opened, followed);
    validate(opened);
    validate(followed);
  }

  #assertProcAuthoritySync(
    fd: number,
    validate: (stat: fsSync.BigIntStats) => void,
  ): void {
    if (fsSync.statfsSync("/proc/self/fd", { bigint: true }).type !== 0x9fa0n) {
      throw new FsSafeError("path-mismatch", "directory mode requires a trusted procfs fd namespace");
    }
    const procPath = `/proc/self/fd/${fd}`;
    const opened = inspectFileIdentitySync(
      () => fsSync.fstatSync(fd, { bigint: true }),
      this.#identity,
    );
    const followed = inspectFileIdentitySync(
      () => fsSync.statSync(procPath, { bigint: true }),
      this.#identity,
    );
    assertOwnedDirectory(opened, followed);
    validate(opened);
    validate(followed);
  }

  async initializeMode(mode: number, checks: TempWorkspaceChildModeChecks): Promise<void> {
    this.#assertModeLeaseReleased();
    this.discardInitialReceipt();
    if (this.#fd === undefined) {
      throw new FsSafeError("path-mismatch", "temp workspace child descriptor is unavailable");
    }
    const fd = this.#fd;
    this.#transferAuthorized = false;
    this.#modeLease = true;
    try {
      checks.assertParent();
      let current = this.#inspectModeTarget(fd, checks.validate);
      checks.assertParent();
      if (checks.hasRequestedMode(current)) return;
      if (this.#proc) {
        await this.#assertProcAuthority(fd, checks.validate);
        // statfs is awaited. Rebind both names and the retained descriptor
        // after that turn before dispatching the procfs descriptor chmod.
        checks.assertParent();
        current = this.#inspectModeTarget(fd, checks.validate);
        checks.assertParent();
        if (checks.hasRequestedMode(current)) return;
        await fs.chmod(`/proc/self/fd/${fd}`, mode & 0o7777);
        await this.#assertProcAuthority(fd, checks.validate);
      } else {
        await chmodDescriptor(fd, mode & 0o7777);
      }
    } finally {
      // The lease outlives every queued fd operation, including failures, so
      // transfer or factory cleanup can never close a still-active descriptor.
      this.#modeLease = false;
    }
  }

  initializeModeSync(mode: number, checks: TempWorkspaceChildModeChecks): void {
    this.#assertModeLeaseReleased();
    if (this.#fd === undefined) {
      throw new FsSafeError("path-mismatch", "temp workspace child descriptor is unavailable");
    }
    const fd = this.#fd;
    this.#transferAuthorized = false;
    this.#modeLease = true;
    try {
      const current = this.#inspectModeTarget(fd, checks.validate, this.#consumeInitialReceipt());
      checks.assertParent();
      if (checks.hasRequestedMode(current)) return;
      if (this.#proc) {
        this.#assertProcAuthoritySync(fd, checks.validate);
        fsSync.chmodSync(`/proc/self/fd/${fd}`, mode & 0o7777);
        this.#assertProcAuthoritySync(fd, checks.validate);
      } else {
        fsSync.fchmodSync(fd, mode & 0o7777);
      }
    } finally {
      this.#modeLease = false;
    }
  }

  get canEnumerate(): boolean {
    return this.#access === "read";
  }

  ensureReadable(): boolean {
    this.#assertModeLeaseReleased();
    this.discardInitialReceipt();
    if (this.canEnumerate) return true;
    if (this.#fd === undefined) {
      throw new FsSafeError("path-mismatch", "temp workspace child descriptor is unavailable");
    }
    // Opening or validating a replacement crosses a new pathname boundary.
    // Even failure must revoke any earlier final-admission receipt.
    this.#transferAuthorized = false;
    let fd: number;
    try {
      fd = openReadableDirectory(this.#dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") return false;
      throw error;
    }
    try {
      const openedStat = inspectTempWorkspaceDescriptorIdentitySync(
        fd,
        this.#identity,
        this.#numericIdentity,
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
    this.#proc = false;
    return true;
  }

  transfer(retainDescriptor: boolean): {
    dir: string;
    identity: Readonly<{ dev: bigint; ino: bigint }>;
    directory: RetainedChildDirectory | undefined;
  } {
    this.#assertModeLeaseReleased();
    this.discardInitialReceipt();
    if (this.#fd === undefined) {
      throw new FsSafeError("path-mismatch", "temp workspace child descriptor is unavailable");
    }
    if (!this.#transferAuthorized) {
      throw new FsSafeError(
        "path-mismatch",
        "temp workspace child has not completed final admission",
      );
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
    this.#assertModeLeaseReleased();
    this.discardInitialReceipt();
    if (this.#fd === undefined) return;
    const fd = this.#fd;
    this.#fd = undefined;
    fsSync.closeSync(fd);
  }
}
