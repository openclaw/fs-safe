import { randomUUID } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import fsSync, { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeMaxBytes } from "./byte-budget.js";
import { assertCopySourceCurrent, resolveFileCopyCloneMode } from "./copy-file-input.js";
import type { ContainmentGuarantee } from "./containment.js";
import { assertAsyncDirectoryGuard, assertSyncDirectoryGuard, createAsyncDirectoryGuard, createNearestExistingDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import { openLocalFileDescriptor } from "./local-file-descriptor.js";
import { assertMutationNotDenied, mergeDenyMutationPolicies, type DenyMutationPolicy } from "./deny-mutations.js";
import { resolveOpenedFileRealPathForFd } from "./opened-realpath.js";
import { openedPathResolutionError, recordExclusiveCreateFailure, recordOpenedFileFailure } from "./opened-file-failure.js";
import { runPinnedWriteHelper, runPinnedWriteWithRenamePolicy } from "./pinned-write.js";
import type { PinnedWriteInput, RenameIdentityPolicy } from "./pinned-write.js";
import { preparePinnedWriteMutationAdmission, snapshotPinnedMutationPolicy } from "./pinned-mutation-admission.js";
import { getNativeBinding } from "./native.js";
import { validatePinnedOperationPayload } from "./pinned-operation.js";
import { PATH_ALIAS_POLICIES } from "./path-policy.js";
import {
  assertNoNulPathInput,
  hasNodeErrorCode,
  isNotFoundPathError,
  isSymlinkOpenError,
} from "./path.js";
import { readOpenedFileSafely, type ReadResult } from "./read-opened-file.js";
import { cleanupPinnedFilePath, removePathIfIdentityUnchanged } from "./replace-file-temp-owner.js";
import { realpathSync } from "./realpath.js";
import { mkdirPathFallback, prepareRootWriteTarget, tryMkdirAtExactParent } from "./root-directory-creation.js";
import { isNonRegularWriteOpenError, resolveNonblockingWriteFlag } from "./write-open-flags.js";
import { resolveRootPath, resolveRootPathForRemoval } from "./root-path.js";
import { RemovalPathReceipts } from "./root-remove-receipt.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { listDirectoryPath, openRootDirectoryListing } from "./root-directory-list.js";
import { statResolvedPathInRoot } from "./root-path-stat.js";
import { entriesInRoot, type RootEntriesOptions } from "./root-entries.js";
import { assertMoveMutationAllowed } from "./root-move-preflight.js";
import {
  assertRootIdentityCurrent,
  assertValidRootDestinationPath,
  assertValidRootRelativePath,
  ensureTrailingSep,
  expandRelativePathWithHome,
  resolvePathInRoot,
  resolveRootContext,
  rootRelativeReadPath,
  type RootContext,
} from "./root-context.js";
import {
  fileNotFoundError,
  hardlinkedPathNotAllowedError,
  isAlreadyExistsError,
  normalizePinnedPathError,
  normalizePinnedWriteError,
  outsideWorkspaceError,
} from "./root-errors.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import type { DirEntry, PathStat } from "./types.js";
import { walkRoot, type RootWalkEntry, type RootWalkOptions } from "./root-walk.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";
import { removePathInRootFallback, validateRemoveOptions } from "./root-remove.js";
import { serializePathWrite } from "./write-queue.js";
import { verifyAtomicWriteResult } from "./root-write-verification.js";
import {
  assertRootWritePathSelectionSync,
  assertRootWriteSelectionSync,
  createRootWriteSelectionForFd,
  prepareGuardedRootWritePathSelection,
  resolveGuardedWritePathInRoot,
  resolveGuardedWriteTargetInRoot,
  resolvePinnedWriteTargetInRoot,
  refreshRetainedRootWriteAdmission,
  refreshRootWritePathSelection,
  retainRootWriteSelection,
  takeRootWriteSelection,
  type PinnedWriteTarget,
} from "./root-write-admission.js";
import { prepareSharedRootWriteTarget } from "./root-write-complete-parent.js";
import { finishRootFallbackWrite } from "./root-write-publication.js";
import { withRootFallbackCompatibilityLock } from "./root-write-compatibility.js";
import { assertRootFallbackWritePath } from "./root-write-lock-binding.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { movePathNoReplaceNative } from "./root-move-noreplace.js";
import { admitRootReadHandle, inspectOpenedPathIdentitySync } from "./root-read-admission.js";
import { createCopyPublicationObserver, onCopyPublication, type CopyPublicationOptions } from "./copy-publication.js";
import { writeAllToFile } from "./write-file-handle.js";
import { createInputOptions, rethrowCreateInputError, rootWriteInput, type RootWriteParams } from "./root-create-input.js";
import { assertFinalSymlinkRejected, mutationSymlinkResolution, readSymlinkResolution, type MutationSymlinkPolicy, type SymlinkPolicy } from "./root-symlink-policy.js";
import { assertNoWindowsPathAlias, resolvePathPreservingWindowsRoot } from "./windows-path-alias.js";
import { resolvePinnedObservedPathInRoot, type PinnedObservedPath } from "./root-observed-path.js";

import {
  mergeReadOptions, readDefaults,
  type HardlinkPolicy, type RootAppendOptions, type RootCopyOptions, type RootCopySource,
  type RootCreateJsonOptions, type RootCreateOptions, type RootCreateStreamOptions, type RootDefaults,
  type RootMkdirOptions, type RootMoveOptions, type RootOpenOptions,
  type RootOpenWritableOptions, type RootReadOptions, type RootRemoveOptions,
  type RootWriteJsonOptions, type RootWriteOptions,
} from "./root-options.js";
import { composeMutationAssertions, MutationAuthorityError, rethrowMutationAuthorityError } from "./mutation-authority.js";
export type {
  HardlinkPolicy, RootAppendOptions, RootCopyOptions, RootCopySource, RootCreateJsonOptions,
  RootCreateOptions, RootCreateStreamOptions, RootDefaults, RootMkdirOptions, RootMoveOptions,
  RootOpenOptions, RootOpenWritableOptions, RootOptions, RootReadOptions,
  RootRemoveOptions, RootWriteJsonOptions, RootWriteOptions, WritableOpenMode,
} from "./root-options.js";
export { DEFAULT_ROOT_MAX_BYTES } from "./root-options.js";

export type { DenyMutationPolicy } from "./deny-mutations.js";
export type { RenameIdentityPolicy } from "./pinned-write.js";
export type { MutationSymlinkPolicy, SymlinkPolicy } from "./root-symlink-policy.js";
export { resolveOpenedFileRealPathForHandle } from "./opened-realpath.js";
export type { ReadResult } from "./read-opened-file.js";
export type OpenResult = {
  handle: FileHandle;
  containment: ContainmentGuarantee;
  realPath: string;
  stat: Stats;
  [Symbol.asyncDispose](): Promise<void>;
};

function logWarn(message: string): void {
  if (process.env.FS_SAFE_DEBUG_WARNINGS === "1") {
    console.warn(message);
  }
}

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_WRITE_EXISTING_FLAGS =
  fsConstants.O_WRONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0) |
  resolveNonblockingWriteFlag();
const OPEN_WRITE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_APPEND_EXISTING_FLAGS =
  fsConstants.O_RDWR | fsConstants.O_APPEND | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0) |
  resolveNonblockingWriteFlag();
const OPEN_APPEND_CREATE_FLAGS =
  fsConstants.O_RDWR |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

function openResult(params: {
  handle: FileHandle;
  realPath: string;
  stat: Stats;
}): OpenResult {
  return {
    handle: params.handle,
    containment: "best-effort",
    realPath: params.realPath,
    stat: params.stat,
    [Symbol.asyncDispose]: () => params.handle.close().catch(() => undefined),
  };
}

async function openVerifiedLocalFile(
  filePath: string,
  options?: { hardlinks?: HardlinkPolicy; symlinks?: SymlinkPolicy; readWrite?: true },
): Promise<{ opened: OpenResult; identity: BigIntStats }> {
  const fsSafeTestHooks = getFsSafeTestHooks();
  const { handle, stat, identity, preOpenStat } = await openLocalFileDescriptor(filePath, options);
  try {
    const inspectPathIdentity = async (inspect: () => Promise<BigIntStats>) => {
      try {
        return await inspectFileIdentity(inspect, identity);
      } catch (error) {
        const failure = isNotFoundPathError(error) ? openedPathResolutionError(fileNotFoundError()) : error;
        if (stat.nlink <= 1 && (!preOpenStat || preOpenStat.nlink <= 1n)) {
          await recordOpenedFileFailure(failure, handle, filePath, identity);
        }
        throw failure;
      }
    };
    await inspectPathIdentity(async () => inspectOpenedPathIdentitySync(filePath, options?.symlinks));

    await fsSafeTestHooks?.afterOpenedPathIdentityCheck?.(filePath, handle);
    const resolved = await resolveOpenedFileRealPathForFd(handle.fd, identity, filePath)
      .catch(async (error: unknown) => {
        if (stat.nlink <= 1 && (!preOpenStat || preOpenStat.nlink <= 1n)) {
          await recordOpenedFileFailure(error, handle, filePath, identity);
        }
        throw error;
      });
    const { realPath } = resolved;
    assertNoWindowsPathAlias(realPath, "filesystem", "resolved file path uses a Windows filesystem namespace alias");
    let resolvedStat: BigIntStats | undefined = resolved.stat;
    await inspectPathIdentity(async () => {
      // Reuse the post-realpath observation; unknown Windows identities still
      // get a fresh observation on inspectFileIdentity's retry.
      const realStat = resolvedStat ?? fsSync.statSync(realPath, { bigint: true });
      resolvedStat = undefined;
      if (options?.hardlinks === "reject" && realStat.nlink > 1n) {
        throw hardlinkedPathNotAllowedError();
      }
      return realStat;
    });

    return { opened: openResult({ handle, realPath, stat }), identity };
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
}

export interface Root {
  readonly rootDir: string;
  readonly rootReal: string;
  readonly rootWithSep: string;
  readonly defaults: RootDefaults;

  resolve(relativePath: string): Promise<string>;
  open(relativePath: string, options?: RootOpenOptions): Promise<OpenResult>;
  read(relativePath: string, options?: RootReadOptions): Promise<ReadResult>;
  readBytes(relativePath: string, options?: RootReadOptions): Promise<Buffer>;
  readText(
    relativePath: string,
    options?: RootReadOptions & { encoding?: BufferEncoding },
  ): Promise<string>;
  readJson<T = unknown>(
    relativePath: string,
    options?: RootReadOptions & { encoding?: BufferEncoding },
  ): Promise<T>;
  readAbsolute(filePath: string, options?: RootReadOptions): Promise<ReadResult>;
  reader(options?: RootReadOptions): (filePath: string) => Promise<Buffer>;
  openWritable(
    relativePath: string,
    options?: RootOpenWritableOptions,
  ): Promise<WritableOpenResult>;
  append(
    relativePath: string,
    data: string | Buffer,
    options?: RootAppendOptions,
  ): Promise<void>;
  remove(relativePath: string, options?: RootRemoveOptions): Promise<void>;
  mkdir(relativePath: string, options?: RootMkdirOptions): Promise<void>;
  ensureRoot(options?: RootMkdirOptions): Promise<void>;
  write(
    relativePath: string,
    data: string | Buffer,
    options?: RootWriteOptions,
  ): Promise<void>;
  create(
    relativePath: string,
    data: string | Buffer,
    options?: RootCreateOptions,
  ): Promise<void>;
  create(relativePath: string, data: AsyncIterable<Uint8Array>, options?: RootCreateStreamOptions): Promise<void>;
  writeJson(
    relativePath: string,
    data: unknown,
    options?: RootWriteJsonOptions,
  ): Promise<void>;
  createJson(
    relativePath: string,
    data: unknown,
    options?: RootCreateJsonOptions,
  ): Promise<void>;
  copyIn(relativePath: string, source: RootCopySource, options?: RootCopyOptions): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  stat(relativePath: string): Promise<PathStat>;
  list(relativePath: string, options?: { withFileTypes?: false }): Promise<string[]>;
  list(relativePath: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
  entries(relativePath: string, options?: RootEntriesOptions): AsyncIterableIterator<DirEntry>;
  move(
    fromRelative: string,
    toRelative: string,
    options?: RootMoveOptions,
  ): Promise<void>;
  walk(relativePath: string, options: RootWalkOptions): AsyncIterableIterator<RootWalkEntry>;
}

export class RootHandle implements Root {
  private readonly rootGuard: RootContext["rootGuard"];
  private readonly rootIdentity: RootContext["rootIdentity"];
  readonly rootDir: string;
  readonly rootReal: string;
  readonly rootWithSep: string;
  readonly defaults: RootDefaults;

  constructor(context: RootContext, defaults: RootDefaults = {}) {
    this.rootGuard = context.rootGuard;
    this.rootIdentity = context.rootIdentity;
    this.rootDir = context.rootDir;
    this.rootReal = context.rootReal;
    this.rootWithSep = context.rootWithSep;
    this.defaults = defaults;
  }

  private get context(): RootContext {
    return {
      rootDir: this.rootDir,
      rootGuard: this.rootGuard,
      rootIdentity: this.rootIdentity,
      rootReal: this.rootReal,
      rootWithSep: this.rootWithSep,
    };
  }

  private mutationOptions<T extends { denyMutations?: DenyMutationPolicy; assertBeforeMutation?: () => void; mutationSymlinks?: MutationSymlinkPolicy }>(options: T): T {
    return {
      ...options,
      assertBeforeMutation: composeMutationAssertions(this.defaults.assertBeforeMutation, options.assertBeforeMutation),
      mutationSymlinks: options.mutationSymlinks ?? this.defaults.mutationSymlinks,
      denyMutations: mergeDenyMutationPolicies(
        this.defaults.denyMutations,
        options.denyMutations,
      ),
    };
  }

  async resolve(relativePath: string): Promise<string> {
    assertValidRootDestinationPath(relativePath);
    return (
      await resolvePathInRoot(this.context, relativePath, { allowFinalSymlink: true, resolveCanonical: true })
    ).resolved;
  }

  async open(relativePath: string, options: RootOpenOptions = {}): Promise<OpenResult> {
    return await openFileInRoot(this.context, {
      relativePath,
      ...readDefaults(this.defaults),
      ...options,
    });
  }

  async read(
    relativePath: string,
    options: RootReadOptions = {},
  ): Promise<ReadResult> {
    return await readFileInRoot(this.context, {
      relativePath,
      ...mergeReadOptions(this.defaults, options),
    });
  }

  async readBytes(relativePath: string, options: RootReadOptions = {}): Promise<Buffer> {
    return (await this.read(relativePath, options)).buffer;
  }

  async readText(
    relativePath: string,
    options: RootReadOptions & { encoding?: BufferEncoding } = {},
  ): Promise<string> {
    const { encoding = "utf8", ...readOptions } = options;
    return (await this.read(relativePath, readOptions)).buffer.toString(encoding);
  }

  async readJson<T = unknown>(
    relativePath: string,
    options: RootReadOptions & { encoding?: BufferEncoding } = {},
  ): Promise<T> {
    return JSON.parse(await this.readText(relativePath, options)) as T;
  }

  async readAbsolute(
    filePath: string,
    options: RootReadOptions = {},
  ): Promise<ReadResult> {
    return await readPathInRoot(this.context, {
      filePath,
      ...mergeReadOptions(this.defaults, options),
    });
  }

  reader(options: RootReadOptions = {}) {
    return async (filePath: string): Promise<Buffer> => {
      return (await this.readAbsolute(filePath, options)).buffer;
    };
  }

  async openWritable(
    relativePath: string,
    options: RootOpenWritableOptions = {},
  ): Promise<WritableOpenResult> {
    assertValidRootDestinationPath(relativePath);
    const writeMode = options.writeMode ?? "replace";
    const target = await openWritableFileInRoot(this.context, {
      relativePath,
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      ...this.mutationOptions(options),
      append: writeMode === "append",
      truncateExisting: writeMode === "replace",
    }).catch(rethrowMutationAuthorityError);
    return target.opened;
  }

  async append(relativePath: string, data: string | Buffer, options: RootAppendOptions = {}): Promise<void> {
    assertValidRootDestinationPath(relativePath);
    await appendFileInRoot(this.context, {
      relativePath,
      data,
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      ...this.mutationOptions(options),
      durable: options.durable ?? this.defaults.durable ?? true,
    }).catch(rethrowMutationAuthorityError);
  }

  async remove(relativePath: string, options: RootRemoveOptions = {}): Promise<void> {
    assertValidRootRelativePath(relativePath);
    validateRemoveOptions(options);
    options.signal?.throwIfAborted();
    await removePathInRoot(this.context, {
      relativePath,
      ...this.mutationOptions(options),
    }).catch(rethrowMutationAuthorityError);
  }

  async mkdir(relativePath: string, options: RootMkdirOptions = {}): Promise<void> {
    assertValidRootDestinationPath(relativePath);
    await mkdirPathInRoot(this.context, {
      relativePath,
      ...this.mutationOptions(options),
    }).catch(rethrowMutationAuthorityError);
  }

  async ensureRoot(options: RootMkdirOptions = {}): Promise<void> {
    await mkdirPathInRoot(this.context, {
      relativePath: "",
      allowRoot: true,
      ...this.mutationOptions(options),
    }).catch(rethrowMutationAuthorityError);
  }

  async write(
    relativePath: string,
    data: string | Buffer,
    options: RootWriteOptions = {},
  ): Promise<void> {
    assertValidRootDestinationPath(relativePath);
    await writeFileInRoot(this.context, {
      relativePath,
      data,
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      renameIdentity: this.defaults.renameIdentity,
      ...this.mutationOptions(options),
      durable: options.durable ?? this.defaults.durable ?? true,
    }).catch(rethrowMutationAuthorityError);
  }

  async create(relativePath: string, data: string | Buffer, options?: RootCreateOptions): Promise<void>;
  async create(relativePath: string, data: AsyncIterable<Uint8Array>, options?: RootCreateStreamOptions): Promise<void>;
  async create(
    relativePath: string,
    data: string | Buffer | AsyncIterable<Uint8Array>,
    options: RootCreateOptions & RootCreateStreamOptions = {},
  ): Promise<void> {
    assertValidRootDestinationPath(relativePath);
    await writeFileInRoot(this.context, {
      relativePath,
      data,
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      ...this.mutationOptions(createInputOptions(data, options, this.defaults.maxBytes)),
      durable: options.durable ?? this.defaults.durable ?? true,
      overwrite: false,
    }).catch(rethrowMutationAuthorityError).catch(rethrowCreateInputError);
  }

  async writeJson(
    relativePath: string,
    data: unknown,
    options: RootWriteJsonOptions = {},
  ): Promise<void> {
    const { replacer, space, trailingNewline = true, ...writeOptions } = options;
    const json = stringifyJsonDocument(data, replacer, space);
    await this.write(relativePath, trailingNewline ? `${json}\n` : json, writeOptions);
  }

  async createJson(
    relativePath: string,
    data: unknown,
    options: RootCreateJsonOptions = {},
  ): Promise<void> {
    const { replacer, space, trailingNewline = true, ...writeOptions } = options;
    const json = stringifyJsonDocument(data, replacer, space);
    await this.create(relativePath, trailingNewline ? `${json}\n` : json, writeOptions);
  }

  async copyIn(
    relativePath: string,
    source: RootCopySource,
    options: RootCopyOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    assertValidRootDestinationPath(relativePath);
    const { maxBytes, ...copyOptions } = this.mutationOptions(options);
    await copyFileInRoot(this.context, {
      source: typeof source === "string" ? source : { root: source.root, relativePath: source.relativePath },
      relativePath,
      maxBytes: normalizeMaxBytes(maxBytes, { defaultValue: this.defaults.maxBytes }),
      mkdir: this.defaults.mkdir,
      ...copyOptions,
      mode: options.mode ?? this.defaults.mode,
      durable: options.durable ?? this.defaults.durable ?? true,
      verifyPublished: (options as CopyPublicationOptions)[onCopyPublication],
    }).catch(rethrowMutationAuthorityError);
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await this.stat(relativePath);
      return true;
    } catch (err) {
      if (err instanceof FsSafeError && err.code === "not-found") {
        return false;
      }
      throw err;
    }
  }

  async stat(relativePath: string): Promise<PathStat> {
    assertValidRootRelativePath(relativePath);
    validatePinnedOperationPayload({ relativePath });
    return await statPathFallback(this.context, relativePath);
  }

  async list(relativePath: string, options?: { withFileTypes?: false }): Promise<string[]>;
  async list(relativePath: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
  async list(
    relativePath: string,
    options: { withFileTypes?: boolean } = {},
  ): Promise<string[] | DirEntry[]> {
    assertValidRootRelativePath(relativePath);
    validatePinnedOperationPayload({ relativePath });
    return await listPathFallback(this.context, relativePath, options.withFileTypes === true);
  }

  async move(
    fromRelative: string,
    toRelative: string,
    options: RootMoveOptions = {},
  ): Promise<void> {
    assertValidRootRelativePath(fromRelative);
    assertValidRootDestinationPath(toRelative);
    validatePinnedOperationPayload({ from: fromRelative, to: toRelative });
    const { denyMutations, assertBeforeMutation, mutationSymlinks } = this.mutationOptions(options);
    const overwrite = options.overwrite ?? false;
    await assertMoveMutationAllowed(this.context, {
      fromRelative,
      toRelative,
      denyMutations,
    });
    await movePathFallback(this.context, {
      fromRelative,
      denyMutations,
      assertBeforeMutation,
      mutationSymlinks,
      overwrite,
      toRelative,
    }).catch(rethrowMutationAuthorityError);
  }
  entries(relativePath: string, options: RootEntriesOptions = {}): AsyncIterableIterator<DirEntry> {
    assertValidRootRelativePath(relativePath);
    return entriesInRoot(this.context, relativePath, {
      ...options,
      symlinks: options.symlinks ?? this.defaults.symlinks,
    });
  }
  walk(relativePath: string, options: RootWalkOptions): AsyncIterableIterator<RootWalkEntry> {
    assertValidRootRelativePath(relativePath);
    return walkRoot({
      rootReal: this.rootReal,
      stat: relative => this.stat(relative),
      list: async (relative, listingOptions) => {
        validatePinnedOperationPayload({ relativePath: relative });
        const resolved = await resolvePinnedPathInRoot(this.context, { relativePath: relative, allowRoot: true });
        return await openRootDirectoryListing(this.context, resolved.resolved, listingOptions);
      },
    }, relativePath, options);
  }
}
export async function root(
  rootDir: string,
  defaults: RootDefaults = {},
): Promise<Root> {
  normalizeMaxBytes(defaults.maxBytes);
  return new RootHandle(await resolveRootContext(rootDir), defaults);
}

// Internal callers that already hold an exact admitted directory capability must
// not recapture a different filesystem object while constructing the Root.
export function rootFromDirectoryGuard(
  guard: { readonly dir: string; readonly realPath: string; readonly stat: BigIntStats },
  defaults: RootDefaults = {},
): Root {
  normalizeMaxBytes(defaults.maxBytes);
  return new RootHandle({
    rootDir: resolvePathPreservingWindowsRoot(guard.dir),
    rootGuard: { dir: guard.realPath, realPath: guard.realPath, stat: guard.stat },
    rootIdentity: { dev: guard.stat.dev, ino: guard.stat.ino },
    rootReal: guard.realPath,
    rootWithSep: ensureTrailingSep(guard.realPath),
  }, defaults);
}

async function openFileInRoot(
  root: RootContext,
  params: RootOpenOptions & { relativePath: string },
): Promise<OpenResult> {
  const { resolved } = await resolvePathInRoot(root, params.relativePath, {
    allowFinalSymlink: true,
    rejectUnsafeDeviceReads: true,
    ...readSymlinkResolution(params.symlinks),
    resolveCanonical: true,
  });

  const fsSafeTestHooks = getFsSafeTestHooks();
  if (fsSafeTestHooks?.afterRootReadPathResolution) {
    await fsSafeTestHooks.afterRootReadPathResolution(resolved);
  }

  const { handle, stat, identity } = await openLocalFileDescriptor(resolved, {
    symlinks: params.symlinks,
  });
  // The admission helper owns the descriptor until the complete root/file/root
  // fence succeeds, then transfers that still-open handle to the caller.
  const admitted = await admitRootReadHandle({
    root, filePath: resolved, opened: { handle, stat }, identity,
    hardlinks: params.hardlinks, symlinks: params.symlinks,
    beforeFinalFence: fsSafeTestHooks?.beforeRootReadFinalFence,
    afterPathIdentityCheck: fsSafeTestHooks?.afterRootReadFinalPathIdentityCheck,
  });
  return openResult(admitted);
}

async function readFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    hardlinks?: HardlinkPolicy;
    symlinks?: SymlinkPolicy;
    maxBytes?: number;
  },
): Promise<ReadResult> {
  const opened = await openFileInRoot(root, params);
  try {
    return await readOpenedFileSafely({ opened, maxBytes: params.maxBytes });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function readPathInRoot(
  root: RootContext,
  params: {
    filePath: string;
    hardlinks?: HardlinkPolicy;
    maxBytes?: number;
    symlinks?: SymlinkPolicy;
  },
): Promise<ReadResult> {
  const relativePath = rootRelativeReadPath(root, params.filePath);
  return await readFileInRoot(root, {
    relativePath,
    hardlinks: params.hardlinks,
    maxBytes: params.maxBytes,
    symlinks: params.symlinks,
  });
}

export async function readLocalFileSafely(params: {
  filePath: string;
  maxBytes?: number;
}): Promise<ReadResult> {
  const maxBytes = normalizeMaxBytes(params.maxBytes);
  const opened = await openLocalFileSafely({ filePath: params.filePath });
  try {
    return await readOpenedFileSafely({ opened, maxBytes });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function openLocalFileSafely(params: { filePath: string }): Promise<OpenResult> {
  const filePath = params.filePath;
  assertNoNulPathInput(filePath, "file path contains a NUL byte");
  assertNoWindowsPathAlias(filePath, "filesystem", "file path uses a Windows filesystem namespace alias");
  return (await openVerifiedLocalFile(filePath)).opened;
}

export type WritableOpenResult = {
  handle: FileHandle;
  containment: ContainmentGuarantee;
  createdForWrite: boolean;
  realPath: string;
  stat: Stats;
  [Symbol.asyncDispose](): Promise<void>;
};

function emitWriteBoundaryWarning(reason: string) {
  logWarn(`security: fs-safe write boundary warning (${reason})`);
}

function buildAtomicWriteTempPath(targetPath: string): string {
  return path.join(path.dirname(targetPath), `.fs-safe-${randomUUID()}.tmp`);
}

function rootWriteQueueKey(root: RootContext, relativePath: string): string {
  return `${root.rootReal}\0${relativePath}`;
}

async function openWritableFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    mkdir?: boolean;
    mode?: number;
    denyMutations?: DenyMutationPolicy;
    assertBeforeMutation?: () => void;
    mutationSymlinks?: MutationSymlinkPolicy;
    truncateExisting?: boolean;
    append?: boolean;
    expectedWritePath?: string;
  },
): Promise<{ opened: WritableOpenResult; identity: BigIntStats }> {
  const guardedTarget = params.denyMutations === undefined && params.mutationSymlinks === undefined
    ? undefined
    : await resolveGuardedWriteTargetInRoot(root, {
      relativePath: params.relativePath,
      denyMutations: params.denyMutations,
      mutationSymlinks: params.mutationSymlinks,
    });
  const { resolved } = guardedTarget?.resolvedPath ?? await resolveGuardedWritePathInRoot(root, {
    relativePath: params.relativePath,
  });
  const prepared = guardedTarget ? await prepareSharedRootWriteTarget(root, {
    relativePath: params.relativePath, guardedTarget, mkdir: params.mkdir,
    assertBeforeMutation: params.assertBeforeMutation,
  }) : undefined;
  const mutationAdmission = prepared?.mutationAdmission;
  const preparedParent = prepared?.preparedParent;
  let ioPath = prepared?.targetPath ?? (params.mkdir === false ? resolved :
    await prepareRootWriteTarget(root, resolved, params.assertBeforeMutation));
  const operationTargetPath = ioPath;
  try {
    assertFinalSymlinkRejected(ioPath, params.mutationSymlinks !== undefined);
    const resolvedRealPath = params.mutationSymlinks === undefined ? realpathSync.native(ioPath) : ioPath;
    const admittedRealPath = admitPathInsideRoot({
      rootPath: root.rootReal,
      candidatePath: resolvedRealPath,
      rootIdentity: root.rootIdentity,
    });
    if (!admittedRealPath) {
      throw outsideWorkspaceError();
    }
    ioPath = admittedRealPath.path;
  } catch (err) {
    if (err instanceof FsSafeError) {
      throw err;
    }
    if (!isNotFoundPathError(err)) {
      throw err;
    }
  }

  assertRootFallbackWritePath(params.expectedWritePath, ioPath);
  const mode = params.mode ?? 0o600;

  let handle: FileHandle;
  let createdForWrite = false;
  let writePathSelection: Awaited<ReturnType<typeof prepareGuardedRootWritePathSelection>> = undefined;
  const existingFlags = params.append ? OPEN_APPEND_EXISTING_FLAGS : OPEN_WRITE_EXISTING_FLAGS;
  const createFlags = params.append ? OPEN_APPEND_CREATE_FLAGS : OPEN_WRITE_CREATE_FLAGS;
  try {
    writePathSelection = guardedTarget
      ? await prepareGuardedRootWritePathSelection(
        guardedTarget,
        ioPath,
        operationTargetPath,
        preparedParent,
      )
      : undefined;
    try {
      if (writePathSelection) assertRootWritePathSelectionSync(root, writePathSelection);
      handle = await fs.open(ioPath, existingFlags, mode);
    } catch (err) {
      if (await isNonRegularWriteOpenError(err, ioPath, existingFlags)) {
        throw new FsSafeError("not-file", "path is not a regular file under root");
      }
      if (!isNotFoundPathError(err)) {
        throw err;
      }
      if (writePathSelection) await refreshRootWritePathSelection(writePathSelection);
      params.assertBeforeMutation?.();
      if (writePathSelection) assertRootWritePathSelectionSync(root, writePathSelection);
      handle = await fs.open(ioPath, createFlags, mode);
      createdForWrite = true;
    }
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw fileNotFoundError();
    }
    if (isSymlinkOpenError(err)) {
      throw new FsSafeError("symlink", "symlink open blocked", { cause: err });
    }
    if (hasNodeErrorCode(err, "EISDIR")) {
      throw new FsSafeError("not-file", "not a file", { cause: err });
    }
    throw err;
  }

  let realPathForCleanup: string | null = null;
  let createdIdentity: BigIntStats | null = null;
  try {
    const stat = fsSync.fstatSync(handle.fd);
    const identity = inspectFileIdentitySync(() => {
      const observed = fsSync.fstatSync(handle.fd, { bigint: true });
      if (!observed.isFile()) {
        throw new FsSafeError("not-file", "path is not a regular file under root");
      }
      if (observed.nlink > 1n) throw hardlinkedPathNotAllowedError();
      return observed;
    });
    if (createdForWrite) createdIdentity = identity;

    let observedIoPath = false;
    try {
      inspectFileIdentitySync(() => {
        const lstat = fsSync.lstatSync(ioPath, { bigint: true });
        observedIoPath = true;
        if (lstat.isSymbolicLink() || !lstat.isFile()) {
          throw new FsSafeError(
            lstat.isSymbolicLink() ? "symlink" : "not-file",
            "path is not a regular file under root",
          );
        }
        if (lstat.nlink > 1n) throw hardlinkedPathNotAllowedError();
        return lstat;
      }, identity);
    } catch (err) {
      if (isNotFoundPathError(err) && !observedIoPath) {
        // The opened file may have been renamed before its first pathname
        // observation. The descriptor-bound resolver below must still find it.
      } else if (err instanceof FsSafeError && err.code === "path-mismatch") {
        throw new FsSafeError("path-mismatch", "path changed during write", { cause: err });
      } else {
        throw err;
      }
    }

    let realPath = (await resolveOpenedFileRealPathForFd(handle.fd, identity, ioPath)).realPath;
    assertNoWindowsPathAlias(realPath, "filesystem", "resolved file path uses a Windows filesystem namespace alias");
    try {
      inspectFileIdentitySync(() => {
        const realStat = fsSync.statSync(realPath, { bigint: true });
        if (!realStat.isFile()) {
          throw new FsSafeError("not-file", "path is not a regular file under root");
        }
        if (realStat.nlink > 1n) throw hardlinkedPathNotAllowedError();
        return realStat;
      }, identity);
    } catch (err) {
      if (err instanceof FsSafeError && err.code === "path-mismatch") {
        throw new FsSafeError("path-mismatch", "path mismatch", { cause: err });
      }
      throw err;
    }
    const admittedRealPath = admitPathInsideRoot({
      rootPath: root.rootReal,
      candidatePath: realPath,
      rootIdentity: root.rootIdentity,
    });
    if (!admittedRealPath) {
      throw outsideWorkspaceError();
    }
    realPath = admittedRealPath.path;
    realPathForCleanup = realPath;
    assertRootFallbackWritePath(params.expectedWritePath, realPath);
    const writeSelection = writePathSelection
      ? createRootWriteSelectionForFd(writePathSelection, handle.fd)
      : undefined;

    // Truncate only after boundary and identity checks complete. This avoids
    // irreversible side effects if a symlink target changes before validation.
    if (params.append !== true && params.truncateExisting !== false && !createdForWrite) {
      if (writeSelection) await refreshRetainedRootWriteAdmission(root, writeSelection, true, handle.fd);
      assertFinalSymlinkRejected(ioPath, params.mutationSymlinks !== undefined);
      params.assertBeforeMutation?.();
      if (writeSelection) assertRootWriteSelectionSync(root, writeSelection, true, handle.fd);
      await handle.truncate(0);
    }
    if (writeSelection) {
      await refreshRetainedRootWriteAdmission(root, writeSelection, true, handle.fd);
      assertRootWriteSelectionSync(root, writeSelection, true, handle.fd);
    }
    const result: WritableOpenResult = {
      handle,
      containment: "best-effort",
      createdForWrite,
      realPath,
      stat,
      [Symbol.asyncDispose]: () => handle.close().catch(() => undefined),
    };
    if (writeSelection) retainRootWriteSelection(result, writeSelection);
    return { opened: result, identity };
  } catch (err) {
    const cleanupCreatedPath = createdForWrite && err instanceof FsSafeError;
    const cleanupPath = realPathForCleanup ?? ioPath;
    await handle.close().catch(() => {});
    if (cleanupCreatedPath && createdIdentity) {
      await removePathIfIdentityUnchanged(cleanupPath, createdIdentity).catch(() => {});
    }
    throw err;
  }
}

async function appendFileInRoot(
  root: RootContext,
  params: RootAppendOptions & { relativePath: string; data: string | Buffer },
): Promise<void> {
  const { opened: target, identity } = await openWritableFileInRoot(root, {
    relativePath: params.relativePath,
    mkdir: params.mkdir,
    mode: params.mode,
    denyMutations: params.denyMutations,
    assertBeforeMutation: params.assertBeforeMutation,
    mutationSymlinks: params.mutationSymlinks,
    truncateExisting: false,
    append: true,
  });
  let dispatched = false;
  // Reverse disposal order closes the handle before path cleanup and retains both failures.
  await using cleanup = {
    async [Symbol.asyncDispose]() {
      if (!dispatched && target.createdForWrite) {
        await removePathIfIdentityUnchanged(target.realPath, identity);
      }
    },
  };
  await using handle = target.handle;
  try {
    let prefix = "";
    if (
      params.prependNewlineIfNeeded === true &&
      !target.createdForWrite &&
      target.stat.size > 0 &&
      ((typeof params.data === "string" && !params.data.startsWith("\n")) ||
        (Buffer.isBuffer(params.data) && params.data.length > 0 && params.data[0] !== 0x0a))
    ) {
      const newline = Buffer.from("\n", typeof params.data === "string" ? params.encoding : "utf8");
      const tail = Buffer.alloc(newline.length);
      const { bytesRead } = await target.handle.read(
        tail, 0, tail.length, Math.max(0, target.stat.size - tail.length),
      );
      if (bytesRead > 0 && (bytesRead !== newline.length || !tail.equals(newline))) {
        prefix = "\n";
      }
    }

    const payload = typeof params.data === "string" ? `${prefix}${params.data}`
      : prefix.length > 0 ? Buffer.concat([Buffer.from(prefix, "utf8"), params.data]) : params.data;
    await writeAllToFile(target.handle, payload, {
      encoding: params.encoding,
      assertBeforeMutation: () => {
        assertFinalSymlinkRejected(target.realPath, params.mutationSymlinks !== undefined);
        params.assertBeforeMutation?.();
        dispatched = true;
      },
    });
    // A successful empty append still creates the file, as Node's appendFile does.
    dispatched = true;
    if (params.durable !== false) await target.handle.sync();
    if (params.durable !== false && target.createdForWrite) {
      await syncDirectoryBestEffort(path.dirname(target.realPath));
    }
  } catch (error) {
    rethrowMutationAuthorityError(error);
  }
}

async function removePathInRoot(
  root: RootContext,
  params: RootRemoveOptions & { relativePath: string },
): Promise<void> {
  validatePinnedOperationPayload({ relativePath: params.relativePath });
  const removalReceipts = params.recursive ? undefined : new RemovalPathReceipts();
  const resolved = await resolvePinnedPathInRoot(root, {
    relativePath: params.relativePath,
    denyMutations: params.denyMutations,
    mutationSymlinks: params.mutationSymlinks,
    remove: true,
    removalReceipts,
  });
  try {
    await removePathInRootFallback(root, resolved.resolved, params, removalReceipts);
  } catch (error) {
    if (params.recursive) throw error;
    throw normalizePinnedPathError(error);
  }
}

async function mkdirPathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    allowRoot?: boolean;
    denyMutations?: DenyMutationPolicy;
    assertBeforeMutation?: () => void;
    mutationSymlinks?: MutationSymlinkPolicy;
  },
): Promise<void> {
  validatePinnedOperationPayload({ relativePath: params.relativePath });
  const policy = params.denyMutations === undefined && params.mutationSymlinks === undefined
    ? undefined
    : snapshotPinnedMutationPolicy(params.denyMutations, params.mutationSymlinks);
  const resolveCurrent = policy
    ? async () => await resolvePinnedPathInRoot(root, {
      ...params,
      denyMutations: policy.denyMutations,
      mutationSymlinks: policy.mutationSymlinks,
    })
    : undefined;
  const resolved = resolveCurrent
    ? await resolveCurrent()
    : await resolvePinnedPathInRoot(root, params);
  const prepared = policy && resolved.relativePosix !== ""
    ? await preparePinnedWriteMutationAdmission({
      rootReal: resolved.rootReal,
      rootWithSep: ensureTrailingSep(resolved.rootReal),
      rootIdentity: root.rootIdentity,
      resolvedTargetPath: resolved.resolved,
      originalPath: params.relativePath,
      defaultRelativeParentPath: path.posix.dirname(resolved.relativePosix) === "."
        ? ""
        : path.posix.dirname(resolved.relativePosix),
      policy,
      resolveCurrent: resolveCurrent!,
    })
    : undefined;
  if (prepared?.mutationAdmission) {
    await getFsSafeTestHooks()?.beforePinnedWriteParentAdmission?.(resolved.resolved);
  }
  try {
    if (prepared?.mutationAdmission && params.assertBeforeMutation === undefined &&
      await tryMkdirAtExactParent(root, resolved.resolved, prepared.mutationAdmission)) return;
    await mkdirPathFallback(
      root,
      resolved,
      params.assertBeforeMutation,
      policy?.mutationSymlinks !== undefined,
      prepared?.mutationAdmission,
    );
  } catch (error) {
    throw normalizePinnedPathError(error);
  }
}

async function writeFileInRoot(
  root: RootContext,
  params: RootWriteParams,
): Promise<void> {
  const input = rootWriteInput(params);
  await serializePathWrite(rootWriteQueueKey(root, params.relativePath), async () => {
    if (
      input.kind === "buffer" && process.platform === "win32" &&
      (params.renameIdentity === "verify-content-with-lock" || !getNativeBinding())
    ) {
      await writeFileFallback(root, { ...params, data: input.data });
      return;
    }

    const pinned = await resolvePinnedWriteTargetInRoot(
      root,
      params.relativePath,
      params.mode,
      params.denyMutations,
      params.overwrite,
      params.mutationSymlinks,
    );

    await serializePathWrite(pinned.targetPath, async () => {
      await commitPinnedWriteInRoot(root, pinned, params, input);
    });
  });
}

async function commitPinnedWriteInRoot(
  root: RootContext,
  pinned: PinnedWriteTarget,
  params: RootWriteParams,
  input: PinnedWriteInput,
): Promise<void> {
  let verifyingPublication = false;
  try {
    await runPinnedWriteWithRenamePolicy({
      rootPath: pinned.rootReal,
      relativeParentPath: pinned.relativeParentPath,
      basename: pinned.basename,
      targetPath: pinned.targetPath,
      renameIdentity: params.renameIdentity,
      mkdir: params.mkdir !== false,
      mode: params.mode ?? pinned.mode,
      sync: params.durable !== false,
      overwrite: params.overwrite,
      rejectFinalSymlink: params.mutationSymlinks !== undefined,
      input,
      maxBytes: params.maxBytes,
      rootIdentity: root.rootIdentity,
      mutationAdmission: pinned.mutationAdmission,
      assertBeforeMutation: params.assertBeforeMutation,
      verifyPublished: async (fd, expectedIdentity, parentGuard) => {
        verifyingPublication = true;
        try {
          await verifyAtomicWriteResult({
            root,
            targetPath: pinned.targetPath,
            fd,
            expectedIdentity,
            parentGuard,
          });
        } catch (error) {
          emitWriteBoundaryWarning(`post-write verification failed: ${String(error)}`);
          throw error;
        }
      },
    });
  } catch (error) {
    if (verifyingPublication) throw error;
    const errorCode = (error as { code?: unknown })?.code;
    if (errorCode === "file_lock_stale" || errorCode === "file_lock_timeout") {
      throw error;
    }
    if (params.overwrite === false && isAlreadyExistsError(error)) {
      throw new FsSafeError("already-exists", "file already exists", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    throw normalizePinnedWriteError(error);
  }
}

async function copyFileInRoot(
  root: RootContext,
  params: RootCopyOptions & {
    source: RootCopySource;
    relativePath: string;
    verifyPublished?: CopyPublicationOptions[typeof onCopyPublication];
  },
): Promise<void> {
  params.signal?.throwIfAborted();
  const clone = resolveFileCopyCloneMode(params.clone);
  let source: OpenResult;
  let sourceIdentity: BigIntStats;
  if (typeof params.source === "string") {
    assertNoNulPathInput(params.source, "source path contains a NUL byte");
    assertNoWindowsPathAlias(params.source, "filesystem", "source path uses a Windows filesystem namespace alias");
    ({ opened: source, identity: sourceIdentity } = await openVerifiedLocalFile(params.source, {
      hardlinks: params.sourceHardlinks,
    }));
  } else {
    source = await params.source.root.open(params.source.relativePath, params.sourceHardlinks === undefined ? undefined : { hardlinks: params.sourceHardlinks });
    try {
      sourceIdentity = await inspectFileIdentity(() => fsSync.fstatSync(source.handle.fd, { bigint: true }));
    } catch (error) {
      await source.handle.close().catch(() => undefined);
      throw error;
    }
  }
  if (params.maxBytes !== undefined && source.stat.size > params.maxBytes) {
    await source.handle.close().catch(() => {});
    throw new FsSafeError(
      "too-large",
      `file exceeds limit of ${params.maxBytes} bytes (got ${source.stat.size})`,
    );
  }

  try {
    await serializePathWrite(rootWriteQueueKey(root, params.relativePath), async () => {
      const pinned = await resolvePinnedWriteTargetInRoot(
        root,
        params.relativePath,
        params.mode ?? (params.preserveSourceMode ? Number(sourceIdentity.mode & 0o7777n) : undefined),
        params.denyMutations,
        params.overwrite !== false,
        params.mutationSymlinks,
      );
      await serializePathWrite(pinned.targetPath, async () => {
        await assertCopySourceCurrent(source, sourceIdentity);
        const verifySource = async () => {
          params.signal?.throwIfAborted();
          if (typeof params.source !== "string") {
            await params.source.root.stat(".");
          }
          await assertCopySourceCurrent(source, sourceIdentity);
        };
        const observer = createCopyPublicationObserver(pinned.targetPath, params.onDestinationPublished);
        try {
          await runPinnedWriteHelper({
            rootPath: pinned.rootReal,
            relativeParentPath: pinned.relativeParentPath,
            basename: pinned.basename,
            mkdir: params.mkdir !== false,
            mode: pinned.mode,
            overwrite: params.overwrite !== false,
            rejectFinalSymlink: params.mutationSymlinks !== undefined,
            maxBytes: params.maxBytes,
            sync: params.durable !== false,
            assertBeforeMutation: params.signal || params.assertBeforeMutation ? () => {
              if (params.signal?.aborted) throw new MutationAuthorityError(params.signal.reason);
              params.assertBeforeMutation?.();
            } : undefined,
            verifyPublished: params.verifyPublished,
            onPublished: observer.onPublished,
            input: { kind: "file", handle: source.handle, size: source.stat.size, clone, signal: params.signal, verifySource },
            rootIdentity: root.rootIdentity,
            mutationAdmission: pinned.mutationAdmission,
          });
        } catch (error) {
          observer.rethrowObserverFailure(error);
          if (params.signal?.aborted && error === params.signal.reason) throw error;
          if (isAlreadyExistsError(error)) {
            throw new FsSafeError("already-exists", "copy destination already exists", { cause: error });
          }
          throw normalizePinnedWriteError(error);
        }
        await verifySource();
      });
    });
  } finally {
    await source.handle.close().catch(() => {});
  }
}

async function resolvePinnedPathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    allowRoot?: boolean;
    denyMutations?: DenyMutationPolicy;
    mutationSymlinks?: MutationSymlinkPolicy;
    remove?: boolean;
    removalReceipts?: RemovalPathReceipts;
  },
): Promise<{ rootReal: string; resolved: string; relativePosix: string }> {
  return await resolvePinnedOperationPathInRoot(root, {
    allowRoot: params.allowRoot,
    denyMutations: params.denyMutations,
    mutationSymlinks: params.mutationSymlinks,
    protectDenyMutationAncestors: params.remove === true,
    relativePath: params.relativePath,
    policy: params.remove ? PATH_ALIAS_POLICIES.unlinkTarget : PATH_ALIAS_POLICIES.strict,
    removalReceipts: params.removalReceipts,
  });
}

async function resolvePinnedOperationPathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    policy: (typeof PATH_ALIAS_POLICIES)[keyof typeof PATH_ALIAS_POLICIES];
    allowRoot?: boolean;
    denyMutations?: DenyMutationPolicy;
    mutationSymlinks?: MutationSymlinkPolicy;
    protectDenyMutationAncestors: boolean;
    removalReceipts?: RemovalPathReceipts;
  },
): Promise<{ rootReal: string; resolved: string; relativePosix: string }> {
  const resolved = await resolvePinnedRootPathInRoot(root, {
    relativePath: params.relativePath,
    policy: params.policy,
    mutationSymlinks: params.mutationSymlinks,
    removalReceipts: params.removalReceipts,
  });
  const relativeResolved = path.relative(resolved.rootReal, resolved.canonicalPath);
  if ((relativeResolved === "" || relativeResolved === ".") && params.allowRoot === true) {
    await assertMutationNotDenied(resolved.canonicalPath, params.denyMutations);
    return { rootReal: resolved.rootReal, resolved: resolved.canonicalPath, relativePosix: "" };
  }
  const firstSegment = relativeResolved.split(path.sep)[0];
  if (
    relativeResolved === "" ||
    relativeResolved === "." ||
    firstSegment === ".." ||
    path.isAbsolute(relativeResolved)
  ) {
    throw outsideWorkspaceError();
  }
  const relativePosix = relativeResolved.split(path.sep).join(path.posix.sep);
  const admittedCanonicalPath = admitPathInsideRoot({
    rootPath: resolved.rootReal,
    candidatePath: resolved.canonicalPath,
    rootIdentity: root.rootIdentity,
  });
  if (!admittedCanonicalPath) {
    throw outsideWorkspaceError();
  }
  resolved.canonicalPath = admittedCanonicalPath.path;
  await assertMutationNotDenied(resolved.canonicalPath, params.denyMutations, {
    protectAncestors: params.protectDenyMutationAncestors,
  });

  return { rootReal: resolved.rootReal, resolved: resolved.canonicalPath, relativePosix };
}

async function resolvePinnedRootPathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    policy: (typeof PATH_ALIAS_POLICIES)[keyof typeof PATH_ALIAS_POLICIES];
    mutationSymlinks?: MutationSymlinkPolicy;
    removalReceipts?: RemovalPathReceipts;
  },
): Promise<{ rootReal: string; rootWithSep: string; canonicalPath: string }> {
  await assertRootIdentityCurrent(root, params.removalReceipts?.observeRoot);
  const rootReal = root.rootReal;
  let resolved;
  try {
    const expandedPath = await expandRelativePathWithHome(params.relativePath);
    const resolution = {
      absolutePath: path.isAbsolute(expandedPath)
        ? expandedPath
        : `${ensureTrailingSep(rootReal)}${expandedPath}`,
      rootPath: rootReal,
      rootCanonicalPath: rootReal,
      rootIdentity: root.rootIdentity,
      boundaryLabel: "root",
      policy: params.policy,
      ...mutationSymlinkResolution(params.mutationSymlinks),
    };
    resolved = await (params.removalReceipts ? resolveRootPathForRemoval(resolution, params.removalReceipts) : resolveRootPath(resolution));
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "symlink") throw err;
    throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
  }
  const rootWithSep = ensureTrailingSep(resolved.rootCanonicalPath);
  return {
    rootReal: resolved.rootCanonicalPath,
    rootWithSep,
    canonicalPath: resolved.canonicalPath,
  };
}

async function statPathFallback(root: RootContext, relativePath: string): Promise<PathStat> {
  const initialObservationHook = getFsSafeTestHooks()?.beforeRootStatInitialObservation;
  const observed = initialObservationHook
    ? undefined
    : await resolvePinnedObservedPathInRoot(root, relativePath, "stat");
  const resolved: PinnedObservedPath = observed ??
    await resolvePinnedPathInRoot(root, { relativePath, allowRoot: true });
  return await statResolvedPathInRoot(root, resolved.resolved, resolved.receipt);
}

async function listPathFallback(
  root: RootContext,
  relativePath: string,
  withFileTypes: boolean,
): Promise<string[] | DirEntry[]> {
  const observed = await resolvePinnedObservedPathInRoot(root, relativePath, "directory");
  const resolved: PinnedObservedPath = observed ??
    await resolvePinnedPathInRoot(root, { relativePath, allowRoot: true });
  return await listDirectoryPath(root, resolved.resolved, withFileTypes, resolved.receipt);
}

async function movePathFallback(
  root: RootContext,
  params: RootMoveOptions & {
    fromRelative: string;
    toRelative: string;
    overwrite: boolean;
  },
): Promise<void> {
  const source = await resolvePathInRoot(root, params.fromRelative, {
    aliasErrorCode: "path-alias",
    allowFinalSymlink: true,
    ...mutationSymlinkResolution(params.mutationSymlinks),
  });
  await assertMutationNotDenied(source.resolved, params.denyMutations, { protectAncestors: true });
  const pinnedSource = await resolvePinnedRootPathInRoot(root, {
    relativePath: params.fromRelative,
    policy: PATH_ALIAS_POLICIES.strict,
    mutationSymlinks: params.mutationSymlinks,
  });
  let pinnedTarget: Awaited<ReturnType<typeof resolvePinnedRootPathInRoot>> | undefined;
  const target = await resolveGuardedWritePathInRoot(root, {
    relativePath: params.toRelative,
    denyMutations: params.denyMutations,
    mutationSymlinks: params.mutationSymlinks,
    allowFinalSymlink: true,
    protectDeniedAncestors: true,
    shouldAssertNoPathAlias: async (resolvedTarget) => {
      pinnedTarget = await resolvePinnedRootPathInRoot(root, {
        relativePath: params.toRelative,
        policy: PATH_ALIAS_POLICIES.unlinkTarget,
      });
      if (!params.overwrite) return true;
      let targetStat: Stats | undefined;
      try { targetStat = fsSync.lstatSync(resolvedTarget.resolved); } catch { /* Advisory lookup. */ }
      return !(
        process.platform !== "win32" &&
        params.overwrite &&
        targetStat?.isSymbolicLink() === true
      );
    },
  });

  let sourceStat: Stats;
  try {
    sourceStat = fsSync.lstatSync(source.resolved);
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw fileNotFoundError(error instanceof Error ? error : undefined);
    }
    throw error;
  }
  if (sourceStat.isSymbolicLink()) {
    throw new FsSafeError("symlink", "symlink not allowed");
  }
  if (sourceStat.isFile() && sourceStat.nlink > 1) {
    throw hardlinkedPathNotAllowedError();
  }
  if (!params.overwrite && sourceStat.isDirectory()) {
    throw new FsSafeError("invalid-path", "directory moves require overwrite: true");
  }
  if (!params.overwrite) {
    if (!pinnedTarget) {
      throw new FsSafeError("path-mismatch", "destination admission was not completed");
    }
    await movePathNoReplaceNative(root, params, {
      sourcePath: source.resolved,
      sourceParentPath: path.dirname(pinnedSource.canonicalPath),
      targetPath: target.resolved,
      targetParentPath: path.dirname(pinnedTarget.canonicalPath),
    });
    return;
  }

  const sourceParentGuard = await createAsyncDirectoryGuard(path.dirname(source.resolved));
  const targetParentGuard = await createNearestExistingDirectoryGuard(target.rootReal, path.dirname(target.resolved));
  await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("move", target.resolved);
  await assertAsyncDirectoryGuard(sourceParentGuard);
  await assertAsyncDirectoryGuard(targetParentGuard);
  try {
    assertFinalSymlinkRejected(source.resolved, params.mutationSymlinks !== undefined);
    assertFinalSymlinkRejected(target.resolved, params.mutationSymlinks !== undefined);
    params.assertBeforeMutation?.();
    await fs.rename(source.resolved, target.resolved);
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw fileNotFoundError(error instanceof Error ? error : undefined);
    }
    if (hasNodeErrorCode(error, "EEXIST")) {
      throw new FsSafeError("already-exists", "destination exists", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    throw error;
  }
  try {
    await assertAsyncDirectoryGuard(sourceParentGuard);
    await assertAsyncDirectoryGuard(targetParentGuard);
  } catch (error) {
    throw normalizePinnedPathError(error);
  }
}

async function writeFileFallback(
  root: RootContext,
  params: RootWriteOptions & { relativePath: string; data: string | Buffer },
): Promise<void> {
  if (params.renameIdentity !== "verify-content-with-lock") return await writeFileFallbackUnlocked(root, params);
  const policy = snapshotPinnedMutationPolicy(params.denyMutations, params.mutationSymlinks);
  if (policy) params = { ...params, ...policy };
  const { rootReal, resolved } = await resolveGuardedWritePathInRoot(root, params);
  await withRootFallbackCompatibilityLock({
    rootPath: rootReal, rootIdentity: root.rootIdentity, targetPath: resolved, assertBeforeMutation: params.assertBeforeMutation,
  }, async ({ targetPath, ...binding }) => await writeFileFallbackUnlocked(root, { ...params, ...binding }, targetPath));
}

async function writeFileFallbackUnlocked(
  root: RootContext,
  params: RootWriteOptions & { relativePath: string; data: string | Buffer },
  expectedWritePath?: string,
): Promise<void> {
  if (params.overwrite === false) {
    await writeMissingFileFallback(root, params, expectedWritePath);
    return;
  }

  const { opened: target, identity: targetIdentity } = await openWritableFileInRoot(root, {
    relativePath: params.relativePath,
    mkdir: params.mkdir,
    // Private, writable placeholder: Windows cannot rename over a read-only file.
    mode: 0o600,
    denyMutations: params.denyMutations,
    assertBeforeMutation: params.assertBeforeMutation,
    mutationSymlinks: params.mutationSymlinks,
    truncateExisting: false,
    expectedWritePath,
  });
  const policyEnabled = params.denyMutations !== undefined || params.mutationSymlinks !== undefined;
  const retainedSelection = policyEnabled ? takeRootWriteSelection(target) : undefined;
  const destinationPath = retainedSelection?.selectedPath ?? target.realPath;
  const mode = params.mode ?? (target.stat.mode & 0o777);
  if (policyEnabled && !retainedSelection) {
    await target.handle.close().catch(() => undefined);
    throw new FsSafeError("path-mismatch", "write admission state was not retained");
  }
  const destinationGuard = retainedSelection?.parentGuard ??
    await createAsyncDirectoryGuard(path.dirname(destinationPath), { bigint: true }).catch(async error => {
      await target.handle.close().catch(() => undefined);
      throw error;
    });
  let tempPath: string | null = null;
  let unregisterTempPath: TempPathRegistration | null = null;
  let writtenHandle: FileHandle | undefined;
  let writtenIdentity: BigIntStats | undefined;
  let placeholderIdentity: BigIntStats | undefined;
  let published = false;
  try {
    if (target.createdForWrite) placeholderIdentity = targetIdentity;
    tempPath = buildAtomicWriteTempPath(destinationPath);
    if (retainedSelection) {
      await refreshRetainedRootWriteAdmission(root, retainedSelection, true, target.handle.fd);
    }
    params.assertBeforeMutation?.();
    if (retainedSelection) {
      assertRootWriteSelectionSync(root, retainedSelection, true, target.handle.fd);
    }
    writtenHandle = await fs.open(tempPath, OPEN_WRITE_CREATE_FLAGS, 0o600);
    writtenIdentity = fsSync.fstatSync(writtenHandle.fd, { bigint: true });
    unregisterTempPath = registerTempPathForExit(tempPath, { identity: writtenIdentity, singleLinkFile: true });
    await writeAllToFile(writtenHandle, params.data, {
      encoding: params.encoding, assertBeforeMutation: params.assertBeforeMutation,
    });
    if (params.durable !== false) await writtenHandle.sync();
    const commitTempPath = tempPath;
    const commitHandle = writtenHandle;
    const commitIdentity = writtenIdentity;
    await withAsyncDirectoryGuards([destinationGuard], async () => {
      await verifyAtomicWriteResult({
        root, targetPath: commitTempPath, fd: commitHandle.fd,
        expectedIdentity: commitIdentity, parentGuard: destinationGuard,
      });
      if (target.createdForWrite) {
        await cleanupPinnedFilePath({
          pathname: destinationPath, handle: target.handle, identity: placeholderIdentity, parentGuard: destinationGuard,
        });
      }
      // Windows cannot replace a destination while its old handle remains open.
      await target.handle.close();
      if (retainedSelection) {
        await refreshRetainedRootWriteAdmission(
          root, retainedSelection, !target.createdForWrite,
        );
      }
      assertFinalSymlinkRejected(destinationPath, params.mutationSymlinks !== undefined);
      params.assertBeforeMutation?.();
      if (retainedSelection) {
        assertRootWriteSelectionSync(root, retainedSelection, !target.createdForWrite);
      }
      await fs.rename(commitTempPath, destinationPath);
      tempPath = null;
      published = true;
    });
    unregisterTempPath();
    unregisterTempPath = null;
    await finishRootFallbackWrite({
      root, targetPath: destinationPath, handle: writtenHandle, identity: writtenIdentity,
      parentGuard: destinationGuard, mode, options: params,
      // Read/write access is needed to sync the accepted destination on Windows.
      openForCompatibility: () => openVerifiedLocalFile(destinationPath, { hardlinks: "reject", readWrite: true }),
      onVerificationFailure: err => emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`),
    });
  } finally {
    if (!published && target.createdForWrite) {
      await cleanupPinnedFilePath({
        pathname: destinationPath, handle: target.handle, identity: placeholderIdentity, parentGuard: destinationGuard,
      });
    }
    await target.handle.close().catch(() => undefined);
    if (tempPath && writtenHandle) {
      await cleanupPinnedFilePath({
        pathname: tempPath, handle: writtenHandle, identity: writtenIdentity, parentGuard: destinationGuard,
      });
    }
    await writtenHandle?.close().catch(() => undefined);
    unregisterTempPath?.();
  }
}

async function writeMissingFileFallback(
  root: RootContext,
  params: RootWriteOptions & { relativePath: string; data: string | Buffer },
  expectedWritePath?: string,
): Promise<void> {
  const guardedTarget = params.denyMutations === undefined && params.mutationSymlinks === undefined
    ? undefined
    : await resolveGuardedWriteTargetInRoot(root, {
      relativePath: params.relativePath,
      denyMutations: params.denyMutations,
      mutationSymlinks: params.mutationSymlinks,
    });
  const { resolved } = guardedTarget?.resolvedPath ?? await resolveGuardedWritePathInRoot(root, {
    relativePath: params.relativePath,
  });
  const prepared = guardedTarget ? await prepareSharedRootWriteTarget(root, {
    relativePath: params.relativePath, guardedTarget, mkdir: params.mkdir,
    assertBeforeMutation: params.assertBeforeMutation,
  }) : undefined;
  const mutationAdmission = prepared?.mutationAdmission;
  const preparedParent = prepared?.preparedParent;
  const targetPath = prepared?.targetPath ?? (params.mkdir === false ? resolved :
    await prepareRootWriteTarget(root, resolved, params.assertBeforeMutation));
  assertRootFallbackWritePath(expectedWritePath, targetPath);
  const pathSelection = guardedTarget
    ? await prepareGuardedRootWritePathSelection(
      guardedTarget,
      targetPath,
      targetPath,
      preparedParent,
    )
    : undefined;
  const parentGuard = pathSelection?.parentGuard ??
    await createAsyncDirectoryGuard(path.dirname(targetPath), { bigint: true });
  let created = false;
  let createdIdentity: BigIntStats | undefined;
  let writtenHandle: FileHandle | undefined;
  let verifyingPublication = false;
  try {
    const { handle, writtenStat } = await withAsyncDirectoryGuards(
      [parentGuard],
      async () => {
        assertFinalSymlinkRejected(targetPath, params.mutationSymlinks !== undefined);
        params.assertBeforeMutation?.();
        if (mutationAdmission) assertSyncDirectoryGuard(parentGuard);
        const handle = await fs.open(targetPath, OPEN_WRITE_CREATE_FLAGS, params.mode ?? 0o600).catch((error) => recordExclusiveCreateFailure(error, targetPath));
        writtenHandle = handle;
        created = true;
        const writtenStat = fsSync.fstatSync(handle.fd, { bigint: true });
        createdIdentity = writtenStat;
        await writeAllToFile(handle, params.data, {
          encoding: params.encoding,
          assertBeforeMutation: () => {
            assertFinalSymlinkRejected(targetPath, params.mutationSymlinks !== undefined);
            params.assertBeforeMutation?.();
            if (mutationAdmission) assertSyncDirectoryGuard(parentGuard);
          },
        });
        if (params.durable !== false) await handle.sync();
        return { handle, writtenStat };
      },
      {
        onPostGuardFailure: () => {
          created = false; // Parent is untrusted now; skip outer path cleanup by name.
        },
      },
    );
    writtenHandle = handle;
    created = false;
    verifyingPublication = true;
    await verifyAtomicWriteResult({
      root,
      targetPath,
      expectedIdentity: writtenStat,
      fd: handle.fd,
      parentGuard,
    });
    if (params.durable !== false) await syncDirectoryBestEffort(path.dirname(targetPath));
  } catch (err) {
    if (verifyingPublication) throw err;
    if (hasNodeErrorCode(err, "EEXIST")) {
      throw new FsSafeError("already-exists", "file already exists", {
        cause: err instanceof Error ? err : undefined,
      });
    }
    throw err;
  } finally {
    if (created && writtenHandle) {
      await cleanupPinnedFilePath({
        pathname: targetPath, handle: writtenHandle, identity: createdIdentity, parentGuard,
      });
    }
    await writtenHandle?.close().catch(() => undefined);
  }
}
