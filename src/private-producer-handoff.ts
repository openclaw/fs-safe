import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import {
  registerTempPathForExit,
  type TempPathRegistration,
} from "./temp-cleanup.js";

export type PrivateProducerHandoff = {
  handle: FileHandle;
  identity: BigIntStats;
  unregister: TempPathRegistration;
};

type HandoffParents = {
  assertSourceParent: () => void;
  assertTargetParent: () => void;
};

type HandoffPaths = HandoffParents & { sourcePath: string; targetPath: string };
type ProducerHandoffParams = HandoffPaths & { readWrite: boolean };
export type CreatedHandoffParams<TSource = FileHandle, TVerification = Promise<void>> = HandoffPaths & {
  source: TSource;
  identity: BigIntStats;
  assertBeforeMutation?: () => void;
  verifyDescriptor?: (fd: number, path: string, links: number) => TVerification;
  onPublished?: () => void;
};

function pathMismatch(message: string): FsSafeError {
  return new FsSafeError("path-mismatch", message);
}

export function assertInitialSource(stat: BigIntStats): void {
  if (stat.isSymbolicLink()) {
    throw new FsSafeError("path-alias", "isolated producer output must not be a symlink");
  }
  if (!stat.isFile()) {
    throw new FsSafeError("not-file", "isolated producer output must be a regular file");
  }
  if (stat.nlink !== 1n) {
    throw new FsSafeError("hardlink", "isolated producer output must have exactly one link");
  }
}

export function inspectLinkedFile(
  inspect: () => BigIntStats,
  expected: BigIntStats,
  links: bigint,
  label: string,
): BigIntStats {
  return inspectFileIdentitySync(() => {
    const stat = inspect();
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== links) {
      throw pathMismatch(`${label} changed during isolated producer handoff`);
    }
    return stat;
  }, expected);
}

export function assertParents(params: HandoffParents): void {
  params.assertTargetParent();
  params.assertSourceParent();
}

export function normalizeLinkError(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EEXIST") {
    return new FsSafeError("already-exists", "isolated producer sibling already exists", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (
    code === "EXDEV" ||
    code === "ENOSYS" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "EPERM"
  ) {
    return new FsSafeError("helper-unavailable", "atomic isolated producer handoff is unavailable", {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return error;
}

function removeSiblingIfOwned(params: {
  assertTargetParent: () => void;
  identity: BigIntStats;
  state: FileHandoff;
  targetPath: string;
}): void {
  if (!params.state.siblingOwned) return;
  params.assertTargetParent();
  let current: BigIntStats;
  try {
    current = fsSync.lstatSync(params.targetPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      params.state.siblingOwned = false;
      return;
    }
    throw error;
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    (current.nlink !== 1n && current.nlink !== 2n) ||
    !sameFileIdentityForCleanup(current, params.identity)
  ) {
    throw pathMismatch("isolated producer sibling changed before cleanup");
  }
  fsSync.unlinkSync(params.targetPath);
  params.state.siblingOwned = false;
  params.assertTargetParent();
}

function combinedFailure(primary: unknown, settlement: readonly unknown[]): unknown {
  if (settlement.length === 0) return primary;
  return new AggregateError(
    [primary, ...settlement],
    "isolated producer handoff and settlement failed",
  );
}

function hasCode(error: unknown, codes: readonly string[]): boolean {
  return !(error instanceof FsSafeError) &&
    codes.includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

async function throwAfterClosing(
  primary: unknown,
  handles: readonly (FileHandle | undefined)[],
): Promise<never> {
  const settlement: unknown[] = [];
  const closed = new Set<FileHandle>();
  for (const handle of handles) {
    if (!handle || closed.has(handle)) continue;
    closed.add(handle);
    try {
      await handle.close();
    } catch (error) {
      settlement.push(error);
    }
  }
  throw combinedFailure(primary, settlement);
}

function inspectSourceDescriptor(handle: FileHandle, identity: BigIntStats, links = 1n): BigIntStats {
  return inspectLinkedFile(
    () => fsSync.fstatSync(handle.fd, { bigint: true }),
    identity,
    links,
    "isolated producer descriptor",
  );
}

function historicalOpenFlags(readWrite: boolean): number {
  const access = readWrite ? fsSync.constants.O_RDWR : fsSync.constants.O_RDONLY;
  return access | resolveReadOpenFlags();
}

async function openHistoricalSource(
  sourcePath: string,
  identity: BigIntStats,
  readWrite: boolean,
  links: bigint,
): Promise<FileHandle> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(sourcePath, historicalOpenFlags(readWrite));
    inspectSourceDescriptor(handle, identity, links);
    return handle;
  } catch (error) {
    if (handle) return await throwAfterClosing(error, [handle]);
    throw error;
  }
}

// Windows data-read access can synchronously inspect a completed file through
// filesystem filters. Prefer write-only admission, which still supports the
// descriptor metadata, chmod and sync operations used below. Providers or
// read-only files that reject that access retain the historical open contract.
async function openProducerSource(
  params: HandoffParents & { sourcePath: string; readWrite: boolean },
  identity: BigIntStats,
  links = 1n,
): Promise<FileHandle> {
  if (process.platform !== "win32") {
    return await openHistoricalSource(params.sourcePath, identity, params.readWrite, links);
  }

  let provisional: FileHandle | undefined;
  try {
    provisional = await fs.open(params.sourcePath, fsSync.constants.O_WRONLY);
  } catch (error) {
    if (!hasCode(error, ["EACCES", "EPERM", "EBUSY"])) throw error;
    return await openHistoricalSource(params.sourcePath, identity, params.readWrite, links);
  }

  try {
    inspectSourceDescriptor(provisional, identity, links);
    return provisional;
  } catch (error) {
    if (!hasCode(error, ["EACCES", "EPERM"])) {
      return await throwAfterClosing(error, [provisional]);
    }
  }

  let fallback: FileHandle | undefined;
  try {
    fallback = await fs.open(params.sourcePath, historicalOpenFlags(params.readWrite));
    inspectSourceDescriptor(fallback, identity, links);
    inspectLinkedFile(
      () => fsSync.lstatSync(params.sourcePath, { bigint: true }),
      identity,
      links,
      "isolated producer path",
    );
    assertParents(params);
  } catch (error) {
    return await throwAfterClosing(error, [fallback, provisional]);
  }

  try {
    await provisional.close();
  } catch (error) {
    return await throwAfterClosing(error, [fallback]);
  }
  return fallback;
}

export class FileHandoff {
  siblingOwned = false;
  publication: "not-published" | "published" | "indeterminate" = "not-published";
  cleanup: "preserved" | "removed" | "failed" = "preserved";
  closeFailed = false;

  constructor(
    private readonly paths: HandoffPaths,
    private readonly identity: BigIntStats,
    private readonly createdLabels = false,
  ) {}

  inspect(owner: { readonly fd: number }, links: bigint): { opened: BigIntStats; named?: BigIntStats } {
    assertParents(this.paths);
    const opened = inspectLinkedFile(() => fsSync.fstatSync(owner.fd, { bigint: true }), this.identity, links,
      this.createdLabels ? "created file descriptor" : "isolated producer descriptor");
    if (this.cleanup !== "removed") {
      inspectLinkedFile(() => fsSync.lstatSync(this.paths.sourcePath, { bigint: true }), this.identity, links,
        this.createdLabels ? "created file stage" : "isolated producer path");
    }
    const named = this.publication === "published"
      ? inspectLinkedFile(() => fsSync.lstatSync(this.paths.targetPath, { bigint: true }), this.identity, links,
        this.createdLabels ? "created file destination" : "isolated producer sibling")
      : undefined;
    return { opened, named };
  }

  publish(): void {
    this.publication = "indeterminate";
    try {
      fsSync.linkSync(this.paths.sourcePath, this.paths.targetPath);
    } catch (error) {
      const normalized = normalizeLinkError(error);
      if (normalized instanceof FsSafeError &&
        (normalized.code === "already-exists" || normalized.code === "helper-unavailable")) {
        this.publication = "not-published";
      }
      throw normalized;
    }
    this.publication = "published";
  }

  retireSource(): void {
    this.cleanup = "failed";
    fsSync.unlinkSync(this.paths.sourcePath);
    this.cleanup = "removed";
  }

  failure(failures: readonly unknown[], aggregateMessage: string): FsSafeError {
    const primary = failures[0];
    // Collision-as-no-op callers must still observe a failed settlement.
    return new FsSafeError(
      this.closeFailed || failures.length > 1 ? "helper-failed" : primary instanceof FsSafeError ? primary.code : "helper-failed",
      "created file publication failed",
      {
        cause: failures.length === 1 ? primary : new AggregateError(failures, aggregateMessage),
        details: {
          publication: { status: this.publication }, cleanup: this.cleanup,
          resources: this.closeFailed ? "close-failed" : "closed",
          path: this.paths.targetPath, dev: this.identity.dev, ino: this.identity.ino,
        },
      },
    );
  }
}

function handoffFile(params: CreatedHandoffParams): Promise<FileHandle>;
function handoffFile(params: ProducerHandoffParams): Promise<PrivateProducerHandoff>;
async function handoffFile(params: CreatedHandoffParams | ProducerHandoffParams): Promise<FileHandle | PrivateProducerHandoff> {
  const created = "source" in params ? params : undefined;
  const identity = created?.identity ?? inspectFileIdentitySync(() => {
    assertParents(params);
    const stat = fsSync.lstatSync(params.sourcePath, { bigint: true });
    assertInitialSource(stat);
    return stat;
  });
  let handle = created?.source;
  const owners = new Set<FileHandle>(handle ? [handle] : []);
  const failures: unknown[] = [];
  let unregister: TempPathRegistration | undefined;
  const state = new FileHandoff(params, identity);

  async function close(owned: FileHandle): Promise<void> {
    // Final creation consumes its pin before close can release and recycle it.
    // Legacy temporary handoff retains its historical FileHandle close retry.
    if (created) owners.delete(owned);
    try {
      await owned.close();
      owners.delete(owned);
    } catch (error) {
      state.closeFailed = true;
      throw error;
    }
  }

  try {
    assertInitialSource(identity);
    if (!handle) {
      handle = await openProducerSource({ ...params, readWrite: "readWrite" in params && params.readWrite }, identity);
      owners.add(handle);
    }
    state.inspect(handle, 1n);
    if (created?.verifyDescriptor) await created.verifyDescriptor(handle.fd, params.sourcePath, 1);
    if (!created) {
      unregister = registerTempPathForExit(params.targetPath, {
        cleanupSync: () => removeSiblingIfOwned({
          assertTargetParent: params.assertTargetParent, identity, state, targetPath: params.targetPath,
        }),
      });
    }

    assertSynchronousCallbackResult(created?.assertBeforeMutation?.(), "assertBeforeMutation");
    state.inspect(handle, 1n);
    state.publish();
    state.siblingOwned = !created;
    try {
      assertSynchronousCallbackResult(created?.onPublished?.(), "onPublished");
    } catch (error) {
      failures.push(error);
    }

    state.inspect(handle, 2n);
    if (process.platform === "win32") {
      // Legacy Windows unlink retains a delete-pending name until handles
      // opened through that name close. Transfer the pin before retiring it.
      const sibling = created
        ? await fs.open(params.targetPath, historicalOpenFlags(true))
        : await openProducerSource({ ...params, sourcePath: params.targetPath,
          readWrite: "readWrite" in params && params.readWrite }, identity, 2n);
      owners.add(sibling);
      state.inspect(sibling, 2n);
      if (created?.verifyDescriptor) await created.verifyDescriptor(sibling.fd, params.targetPath, 2);
      state.inspect(sibling, 2n);
      inspectSourceDescriptor(handle, identity, 2n);
      await close(handle);
      handle = sibling;
      // The old handle's close yielded; both names must still be ours.
      state.inspect(handle, 2n);
    }

    if (created?.verifyDescriptor) await created.verifyDescriptor(
      handle.fd, process.platform === "win32" ? params.targetPath : params.sourcePath, 2,
    );
    assertSynchronousCallbackResult(created?.assertBeforeMutation?.(), "assertBeforeMutation");
    state.inspect(handle, 2n);
    state.retireSource();
    if (created?.verifyDescriptor) await created.verifyDescriptor(handle.fd, params.targetPath, 1);
    const { opened, named } = state.inspect(handle, 1n);
    const originalMode = identity.mode & 0o777n;
    if (!created && process.platform === "win32" && (originalMode & 0o200n) === 0n &&
      ((opened.mode & 0o777n) !== originalMode || (named!.mode & 0o777n) !== originalMode)) {
      // Legacy unlink clears the shared read-only attribute. Repair only the
      // admitted sibling inode, without reopening or chmodding its pathname.
      assertParents(params);
      fsSync.fchmodSync(handle.fd, Number(originalMode));
      const restored = state.inspect(handle, 1n);
      if ((restored.opened.mode & 0o777n) !== originalMode || (restored.named!.mode & 0o777n) !== originalMode) {
        throw pathMismatch("isolated producer read-only mode could not be restored");
      }
    }

    if (!created) {
      const registered = unregister!;
      const release = (() => {
        state.siblingOwned = false;
        registered();
      }) as TempPathRegistration;
      release.setIdentity = registered.setIdentity;
      return { handle, identity, unregister: release };
    }
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 0) return handle!;
  if (unregister) {
    try {
      removeSiblingIfOwned({ assertTargetParent: params.assertTargetParent, identity, state, targetPath: params.targetPath });
      unregister();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const owned of [...owners].reverse()) {
    try { await close(owned); }
    catch (error) { failures.push(error); }
  }
  if (!created) throw combinedFailure(failures[0], failures.slice(1));
  throw state.failure(failures, "isolated producer handoff and settlement failed");
}

export function handoffPrivateProducerFile(params: ProducerHandoffParams): Promise<PrivateProducerHandoff> {
  return handoffFile(params);
}

export function handoffCreatedFile(params: CreatedHandoffParams): Promise<FileHandle> {
  return handoffFile(params);
}
