import { randomUUID } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import fsSync, { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeMaxBytes } from "./byte-budget.js";
import type { ContainmentGuarantee } from "./containment.js";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard, createNearestExistingDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { syncDirectoryBestEffort } from "./directory-durability.js";
import {
  sameFileIdentity,
  sameFileIdentityForCleanup,
  type FileIdentityStat,
} from "./file-identity.js";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import {
  assertMutationNotDenied,
  mergeDenyMutationPolicies,
  type DenyMutationPolicy,
} from "./deny-mutations.js";
import { resolveOpenedFileRealPathForFd, resolveOpenedFileRealPathForHandle } from "./opened-realpath.js";
import { openedPathResolutionError, recordExclusiveCreateFailure, recordFileOpenFailure, recordOpenedFileFailure, recordPreOpenFileChange } from "./opened-file-failure.js";
import {
  type RenameIdentityPolicy,
  runPinnedWriteHelper,
  runPinnedWriteWithRenamePolicy,
} from "./pinned-write.js";
import { getNativeBinding } from "./native.js";
import { validatePinnedOperationPayload } from "./pinned-operation.js";
import { assertNoPathAliasEscape, PATH_ALIAS_POLICIES } from "./path-policy.js";
import {
  assertNoNulPathInput,
  assertNoUnsafeDeviceReadPath,
  hasNodeErrorCode,
  isNotFoundPathError,
  isPathInside,
  isSymlinkOpenError,
} from "./path.js";
import { readOpenedFileSafely, type ReadResult } from "./read-opened-file.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { isNonRegularWriteOpenError, resolveNonblockingWriteFlag } from "./write-open-flags.js";
import { resolveRootPath } from "./root-path.js";
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
  normalizeRemoveGuardError,
  normalizeRemovePathError,
  outsideWorkspaceError,
} from "./root-errors.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import type { DirEntry, PathStat } from "./types.js";
import { walkRoot, type RootWalkEntry, type RootWalkOptions } from "./root-walk.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";
import { serializePathWrite } from "./write-queue.js";
import { verifyAtomicWriteResult } from "./root-write-verification.js";
import { inheritWriteTargetMode } from "./root-write-mode.js";
import { inspectFileIdentity } from "./strict-file-identity.js";

export type { DenyMutationPolicy } from "./deny-mutations.js";
export type { RenameIdentityPolicy } from "./pinned-write.js";
export { resolveOpenedFileRealPathForHandle } from "./opened-realpath.js";
export type { ReadResult } from "./read-opened-file.js";
export type OpenResult = {
  handle: FileHandle;
  containment: ContainmentGuarantee;
  realPath: string;
  stat: Stats;
  [Symbol.asyncDispose](): Promise<void>;
};

export type RootOptions = {
  rootDir: string;
  defaults?: RootDefaults;
};

export type SymlinkPolicy = "reject" | "follow-within-root";
export type HardlinkPolicy = "reject" | "allow";
export type WritableOpenMode = "replace" | "append" | "update";

export type RootDefaults = {
  durable?: boolean;
  hardlinks?: HardlinkPolicy;
  maxBytes?: number;
  mkdir?: boolean;
  mode?: number;
  denyMutations?: DenyMutationPolicy;
  nonBlockingRead?: boolean;
  renameIdentity?: RenameIdentityPolicy;
  symlinks?: SymlinkPolicy;
};

export type RootReadOptions = Pick<
  RootDefaults,
  "hardlinks" | "maxBytes" | "nonBlockingRead" | "symlinks"
>;

export type RootOpenOptions = Omit<RootReadOptions, "maxBytes">;

export type RootWriteOptions = Pick<RootDefaults, "denyMutations" | "durable" | "mkdir" | "mode" | "renameIdentity"> & {
  encoding?: BufferEncoding;
  overwrite?: boolean;
};

export type RootOpenWritableOptions = Pick<RootDefaults, "denyMutations" | "mkdir" | "mode"> & {
  writeMode?: WritableOpenMode;
};

export type RootCopyOptions = Pick<RootDefaults, "denyMutations" | "maxBytes" | "mkdir" | "mode"> & {
  sourceHardlinks?: HardlinkPolicy;
};

export type RootWriteJsonOptions = RootWriteOptions & {
  replacer?: Parameters<typeof JSON.stringify>[1];
  space?: Parameters<typeof JSON.stringify>[2];
  trailingNewline?: boolean;
};

export type RootCreateOptions = Omit<RootWriteOptions, "overwrite">;
export type RootCreateJsonOptions = Omit<RootWriteJsonOptions, "overwrite">;

export type RootAppendOptions = RootWriteOptions & {
  prependNewlineIfNeeded?: boolean;
};

export type RootMoveOptions = Pick<RootDefaults, "denyMutations"> & {
  overwrite?: boolean;
};

export type RootRemoveOptions = Pick<RootDefaults, "denyMutations">;
export type RootMkdirOptions = Pick<RootDefaults, "denyMutations">;

type RootReadParams = Omit<RootReadOptions, "nonBlockingRead">;

function logWarn(message: string): void {
  if (process.env.FS_SAFE_DEBUG_WARNINGS === "1") {
    console.warn(message);
  }
}

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const OPEN_READ_FLAGS = resolveReadOpenFlags();
const OPEN_READ_FOLLOW_FLAGS = resolveReadOpenFlags({ followSymlinks: true });
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

export const DEFAULT_ROOT_MAX_BYTES = 16 * 1024 * 1024;

function pathStatFromStats(stat: Stats): PathStat {
  return {
    dev: Number(stat.dev),
    gid: Number(stat.gid),
    ino: Number(stat.ino),
    isDirectory: stat.isDirectory(),
    isFile: stat.isFile(),
    isSymbolicLink: stat.isSymbolicLink(),
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    nlink: stat.nlink,
    size: stat.size,
    uid: stat.uid,
  };
}

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
  options?: {
    hardlinks?: HardlinkPolicy;
    symlinks?: SymlinkPolicy;
  },
): Promise<{ opened: OpenResult; identity: BigIntStats }> {
  assertNoUnsafeDeviceReadPath(filePath);
  const fsSafeTestHooks = getFsSafeTestHooks();
  let preOpenStat: BigIntStats | undefined;
  let observedBeforeOpen = false;
  // Reject directories before opening so we never surface EISDIR to callers (e.g. tool
  // results that get sent to messaging channels). See openclaw/openclaw#31186.
  try {
    preOpenStat = await inspectFileIdentity(async () => {
      const stat = fsSync.lstatSync(filePath, { bigint: true });
      observedBeforeOpen = true;
      if (stat.isSymbolicLink() && options?.symlinks !== "follow-within-root") {
        throw new FsSafeError("symlink", "symlink not allowed");
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new FsSafeError("not-file", "not a file");
      }
      return stat;
    });
  } catch (err) {
    if (err instanceof FsSafeError || observedBeforeOpen) {
      throw err;
    }
    // Only an initial lookup failure falls through; a failed re-inspection aborts.
  }
  if (preOpenStat) {
    await fsSafeTestHooks?.afterPreOpenLstat?.(filePath);
  }

  const openFlags = options?.symlinks === "follow-within-root"
    ? OPEN_READ_FOLLOW_FLAGS
    : OPEN_READ_FLAGS;
  await fsSafeTestHooks?.beforeOpen?.(filePath, openFlags);
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, openFlags).catch((error: unknown) =>
      recordFileOpenFailure(isNotFoundPathError(error) ? fileNotFoundError() : error, filePath));
  } catch (err) {
    if (isSymlinkOpenError(err)) {
      throw new FsSafeError("symlink", "symlink open blocked", { cause: err });
    }
    // Defensive: if open still throws EISDIR (e.g. race), sanitize so it never leaks.
    if (hasNodeErrorCode(err, "EISDIR")) {
      throw new FsSafeError("not-file", "not a file");
    }
    throw err;
  }

  try {
    await fsSafeTestHooks?.afterOpen?.(filePath, handle);
    const stat = fsSync.fstatSync(handle.fd);
    if (!stat.isFile()) {
      throw new FsSafeError("not-file", "not a file");
    }
    // Keep numeric Stats for the public receipt, never for identity verification.
    let openedIdentity: BigIntStats | undefined;
    const identity = await inspectFileIdentity(
      async () => (openedIdentity = fsSync.fstatSync(handle.fd, { bigint: true })),
      preOpenStat && !preOpenStat.isSymbolicLink() ? preOpenStat : undefined,
    ).catch(async (error: unknown) => {
      if ([0, 1].includes(stat.nlink)) {
        await recordPreOpenFileChange(error, handle, filePath, preOpenStat, openedIdentity);
      }
      throw error;
    });
    if (options?.hardlinks === "reject" && stat.nlink > 1) {
      throw hardlinkedPathNotAllowedError();
    }

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
    await inspectPathIdentity(async () => {
      const pathStat = options?.symlinks === "follow-within-root"
        ? fsSync.statSync(filePath, { bigint: true })
        : fsSync.lstatSync(filePath, { bigint: true });
      if (pathStat.isSymbolicLink() && options?.symlinks !== "follow-within-root") {
        throw new FsSafeError("symlink", "symlink not allowed");
      }
      return pathStat;
    });

    await fsSafeTestHooks?.afterOpenedPathIdentityCheck?.(filePath, handle);
    const resolved = await resolveOpenedFileRealPathForFd(handle.fd, identity, filePath)
      .catch(async (error: unknown) => {
        if (stat.nlink <= 1 && (!preOpenStat || preOpenStat.nlink <= 1n)) {
          await recordOpenedFileFailure(error, handle, filePath, identity);
        }
        throw error;
      });
    const { realPath } = resolved;
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
  copyIn(relativePath: string, sourcePath: string, options?: RootCopyOptions): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  stat(relativePath: string): Promise<PathStat>;
  list(relativePath: string, options?: { withFileTypes?: false }): Promise<string[]>;
  list(relativePath: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
  move(
    fromRelative: string,
    toRelative: string,
    options?: RootMoveOptions,
  ): Promise<void>;
  walk(relativePath: string, options: RootWalkOptions): AsyncIterableIterator<RootWalkEntry>;
}

export class RootHandle implements Root {
  private readonly rootIdentity: RootContext["rootIdentity"];
  readonly rootDir: string;
  readonly rootReal: string;
  readonly rootWithSep: string;
  readonly defaults: RootDefaults;

  constructor(context: RootContext, defaults: RootDefaults = {}) {
    this.rootIdentity = context.rootIdentity;
    this.rootDir = context.rootDir;
    this.rootReal = context.rootReal;
    this.rootWithSep = context.rootWithSep;
    this.defaults = defaults;
  }

  private get context(): RootContext {
    return {
      rootDir: this.rootDir,
      rootIdentity: this.rootIdentity,
      rootReal: this.rootReal,
      rootWithSep: this.rootWithSep,
    };
  }

  private mutationOptions<T extends { denyMutations?: DenyMutationPolicy }>(options: T): T {
    return {
      ...options,
      denyMutations: mergeDenyMutationPolicies(
        this.defaults.denyMutations,
        options.denyMutations,
      ),
    };
  }

  async resolve(relativePath: string): Promise<string> {
    assertValidRootDestinationPath(relativePath);
    return (
      await resolvePathInRoot(this.context, relativePath, { allowFinalSymlink: true })
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
    return await openWritableFileInRoot(this.context, {
      relativePath,
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      ...this.mutationOptions(options),
      append: writeMode === "append",
      truncateExisting: writeMode === "replace",
    });
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
    });
  }

  async remove(relativePath: string, options: RootRemoveOptions = {}): Promise<void> {
    assertValidRootRelativePath(relativePath);
    await removePathInRoot(this.context, {
      relativePath,
      ...this.mutationOptions(options),
    });
  }

  async mkdir(relativePath: string, options: RootMkdirOptions = {}): Promise<void> {
    assertValidRootDestinationPath(relativePath);
    await mkdirPathInRoot(this.context, {
      relativePath,
      ...this.mutationOptions(options),
    });
  }

  async ensureRoot(options: RootMkdirOptions = {}): Promise<void> {
    await mkdirPathInRoot(this.context, {
      relativePath: "",
      allowRoot: true,
      ...this.mutationOptions(options),
    });
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
    });
  }

  async create(
    relativePath: string,
    data: string | Buffer,
    options: RootCreateOptions = {},
  ): Promise<void> {
    assertValidRootDestinationPath(relativePath);
    await writeFileInRoot(this.context, {
      relativePath,
      data,
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      ...this.mutationOptions(options),
      durable: options.durable ?? this.defaults.durable ?? true,
      overwrite: false,
    });
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
    sourcePath: string,
    options: RootCopyOptions = {},
  ): Promise<void> {
    assertValidRootDestinationPath(relativePath);
    const { maxBytes, ...copyOptions } = this.mutationOptions(options);
    await copyFileInRoot(this.context, {
      sourcePath,
      relativePath,
      maxBytes: normalizeMaxBytes(maxBytes, { defaultValue: this.defaults.maxBytes }),
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      ...copyOptions,
    });
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
    const { denyMutations } = this.mutationOptions(options);
    await assertMoveMutationAllowed(this.context, {
      fromRelative,
      toRelative,
      denyMutations,
    });
    await movePathFallback(this.context, {
      fromRelative,
      denyMutations,
      overwrite: options.overwrite ?? false,
      toRelative,
    });
  }
  walk(relativePath: string, options: RootWalkOptions): AsyncIterableIterator<RootWalkEntry> {
    assertValidRootRelativePath(relativePath);
    return walkRoot(this, relativePath, options);
  }
}
function readDefaults(defaults: RootDefaults): RootReadParams {
  return {
    hardlinks: defaults.hardlinks,
    maxBytes: normalizeMaxBytes(defaults.maxBytes, { defaultValue: DEFAULT_ROOT_MAX_BYTES }),
    symlinks: defaults.symlinks,
  };
}

function mergeReadOptions(defaults: RootDefaults, options: RootReadOptions): RootReadParams {
  const merged = readDefaults(defaults);
  if (options.hardlinks !== undefined) merged.hardlinks = options.hardlinks;
  merged.maxBytes = normalizeMaxBytes(options.maxBytes, { defaultValue: merged.maxBytes });
  if (options.symlinks !== undefined) merged.symlinks = options.symlinks;
  return merged;
}

export async function root(
  rootDir: string,
  defaults: RootDefaults = {},
): Promise<Root> {
  normalizeMaxBytes(defaults.maxBytes);
  return new RootHandle(await resolveRootContext(rootDir), defaults);
}

async function openFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    hardlinks?: HardlinkPolicy;
    symlinks?: SymlinkPolicy;
  },
): Promise<OpenResult> {
  const { rootWithSep, resolved } = await resolvePathInRoot(root, params.relativePath, {
    allowFinalSymlink: true,
    rejectUnsafeDeviceReads: true,
    rejectSymlinks: params.symlinks !== "follow-within-root",
  });

  const { opened } = await openVerifiedLocalFile(resolved, {
    symlinks: params.symlinks,
  });

  if (params.hardlinks !== "allow" && opened.stat.nlink > 1) {
    await opened.handle.close().catch(() => {});
    throw hardlinkedPathNotAllowedError();
  }

  if (!isPathInside(rootWithSep, opened.realPath)) {
    await opened.handle.close().catch(() => {});
    throw outsideWorkspaceError();
  }

  return opened;
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
  assertNoNulPathInput(params.filePath, "file path contains a NUL byte");
  return (await openVerifiedLocalFile(params.filePath)).opened;
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

type PinnedWriteTarget = { rootReal: string; targetPath: string; relativeParentPath: string; basename: string; mode: number };

async function prepareRootWriteTarget(rootReal: string, targetPath: string): Promise<string> {
  const parentPath = await mkdirPathComponentsWithGuards({
    rootReal,
    targetPath: path.dirname(targetPath),
  });
  // Continue through the guarded walk's real parent instead of re-entering
  // the original path through a symlinked component.
  return path.join(parentPath, path.basename(targetPath));
}

async function writeTempFileForAtomicReplace(params: {
  tempPath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mode: number;
}): Promise<{ handle: FileHandle; identity: BigIntStats }> {
  const tempHandle = await fs.open(params.tempPath, OPEN_WRITE_CREATE_FLAGS, params.mode);
  try {
    if (typeof params.data === "string") {
      await tempHandle.writeFile(params.data, params.encoding ?? "utf8");
    } else {
      await tempHandle.writeFile(params.data);
    }
    return {
      handle: tempHandle,
      identity: fsSync.fstatSync(tempHandle.fd, { bigint: true }),
    };
  } catch (error) {
    await tempHandle.close().catch(() => {});
    throw error;
  }
}

type GuardedWritePath = Awaited<ReturnType<typeof resolvePathInRoot>>;

async function resolveGuardedWritePathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    denyMutations?: DenyMutationPolicy;
    allowFinalSymlink?: boolean;
    protectDeniedAncestors?: boolean;
    shouldAssertNoPathAlias?: (resolved: GuardedWritePath) => Promise<boolean> | boolean;
  },
): Promise<GuardedWritePath> {
  const resolvedPath = await resolvePathInRoot(root, params.relativePath, {
    aliasErrorCode: "path-alias",
    allowFinalSymlink: params.allowFinalSymlink,
  });
  await assertMutationNotDenied(
    resolvedPath.resolved,
    params.denyMutations,
    params.protectDeniedAncestors ? { protectAncestors: true } : undefined,
  );
  if (await (params.shouldAssertNoPathAlias?.(resolvedPath) ?? true)) {
    try {
      await assertNoPathAliasEscape({
        absolutePath: resolvedPath.resolved,
        rootPath: resolvedPath.rootReal,
        boundaryLabel: "root",
      });
    } catch (error) {
      throw new FsSafeError("path-alias", "path alias escape blocked", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
  return resolvedPath;
}

async function openWritableFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    mkdir?: boolean;
    mode?: number;
    denyMutations?: DenyMutationPolicy;
    truncateExisting?: boolean;
    append?: boolean;
  },
): Promise<WritableOpenResult> {
  const { rootReal, rootWithSep, resolved } = await resolveGuardedWritePathInRoot(root, {
    relativePath: params.relativePath,
    denyMutations: params.denyMutations,
  });
  let ioPath = params.mkdir === false
    ? resolved
    : await prepareRootWriteTarget(rootReal, resolved);
  try {
    const resolvedRealPath = fsSync.realpathSync(ioPath);
    if (!isPathInside(rootWithSep, resolvedRealPath)) {
      throw outsideWorkspaceError();
    }
    ioPath = resolvedRealPath;
  } catch (err) {
    if (err instanceof FsSafeError) {
      throw err;
    }
    if (!isNotFoundPathError(err)) {
      throw err;
    }
  }

  const mode = params.mode ?? 0o600;

  let handle: FileHandle;
  let createdForWrite = false;
  const existingFlags = params.append ? OPEN_APPEND_EXISTING_FLAGS : OPEN_WRITE_EXISTING_FLAGS;
  const createFlags = params.append ? OPEN_APPEND_CREATE_FLAGS : OPEN_WRITE_CREATE_FLAGS;
  try {
    try {
      handle = await fs.open(ioPath, existingFlags, mode);
    } catch (err) {
      if (await isNonRegularWriteOpenError(err, ioPath, existingFlags)) {
        throw new FsSafeError("not-file", "path is not a regular file under root");
      }
      if (!isNotFoundPathError(err)) {
        throw err;
      }
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
  let createdIdentity: Stats | null = null;
  try {
    const stat = fsSync.fstatSync(handle.fd);
    if (createdForWrite) {
      createdIdentity = stat;
    }
    if (!stat.isFile()) {
      throw new FsSafeError("not-file", "path is not a regular file under root");
    }
    if (stat.nlink > 1) {
      throw hardlinkedPathNotAllowedError();
    }

    try {
      const lstat = fsSync.lstatSync(ioPath);
      if (lstat.isSymbolicLink() || !lstat.isFile()) {
        throw new FsSafeError(
          lstat.isSymbolicLink() ? "symlink" : "not-file",
          "path is not a regular file under root",
        );
      }
      if (!sameFileIdentity(stat, lstat)) {
        throw new FsSafeError("path-mismatch", "path changed during write");
      }
    } catch (err) {
      if (!isNotFoundPathError(err)) {
        throw err;
      }
    }

    const realPath = await resolveOpenedFileRealPathForHandle(handle, ioPath);
    realPathForCleanup = realPath;
    const realStat = fsSync.statSync(realPath);
    if (!sameFileIdentity(stat, realStat)) {
      throw new FsSafeError("path-mismatch", "path mismatch");
    }
    if (realStat.nlink > 1) {
      throw hardlinkedPathNotAllowedError();
    }
    if (!isPathInside(rootWithSep, realPath)) {
      throw outsideWorkspaceError();
    }

    // Truncate only after boundary and identity checks complete. This avoids
    // irreversible side effects if a symlink target changes before validation.
    if (params.append !== true && params.truncateExisting !== false && !createdForWrite) {
      await handle.truncate(0);
    }
    return {
      handle,
      containment: "best-effort",
      createdForWrite,
      realPath,
      stat,
      [Symbol.asyncDispose]: () => handle.close().catch(() => undefined),
    };
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
  params: {
    relativePath: string;
    data: string | Buffer;
    durable?: boolean;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    mode?: number;
    denyMutations?: DenyMutationPolicy;
    prependNewlineIfNeeded?: boolean;
  },
): Promise<void> {
  const target = await openWritableFileInRoot(root, {
    relativePath: params.relativePath,
    mkdir: params.mkdir,
    mode: params.mode,
    denyMutations: params.denyMutations,
    truncateExisting: false,
    append: true,
  });
  try {
    let prefix = "";
    if (
      params.prependNewlineIfNeeded === true &&
      !target.createdForWrite &&
      target.stat.size > 0 &&
      ((typeof params.data === "string" && !params.data.startsWith("\n")) ||
        (Buffer.isBuffer(params.data) && params.data.length > 0 && params.data[0] !== 0x0a))
    ) {
      const lastByte = Buffer.alloc(1);
      const { bytesRead } = await target.handle.read(lastByte, 0, 1, target.stat.size - 1);
      if (bytesRead === 1 && lastByte[0] !== 0x0a) {
        prefix = "\n";
      }
    }

    if (typeof params.data === "string") {
      await target.handle.appendFile(`${prefix}${params.data}`, params.encoding ?? "utf8");
    } else {
      const payload =
        prefix.length > 0 ? Buffer.concat([Buffer.from(prefix, "utf8"), params.data]) : params.data;
      await target.handle.appendFile(payload);
    }
    if (params.durable !== false) await target.handle.sync();
    if (params.durable !== false && target.createdForWrite) {
      await syncDirectoryBestEffort(path.dirname(target.realPath));
    }
  } finally {
    await target.handle.close().catch(() => {});
  }
}

async function removePathInRoot(
  root: RootContext,
  params: { relativePath: string; denyMutations?: DenyMutationPolicy },
): Promise<void> {
  validatePinnedOperationPayload({ relativePath: params.relativePath });
  const resolved = await resolvePinnedPathInRoot(root, {
    relativePath: params.relativePath,
    denyMutations: params.denyMutations,
    remove: true,
  });
  try {
    await removePathFallback(resolved);
  } catch (error) {
    throw normalizePinnedPathError(error);
  }
}

async function mkdirPathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    allowRoot?: boolean;
    denyMutations?: DenyMutationPolicy;
  },
): Promise<void> {
  validatePinnedOperationPayload({ relativePath: params.relativePath });
  const resolved = await resolvePinnedPathInRoot(root, params);
  try {
    await mkdirPathFallback(resolved);
  } catch (error) {
    throw normalizePinnedPathError(error);
  }
}

async function writeFileInRoot(
  root: RootContext,
  params: RootWriteOptions & { relativePath: string; data: string | Buffer },
): Promise<void> {
  await serializePathWrite(rootWriteQueueKey(root, params.relativePath), async () => {
    if (
      process.platform === "win32" &&
      (params.renameIdentity === "verify-content-with-lock" || !getNativeBinding())
    ) {
      await writeFileFallback(root, params);
      return;
    }

    const pinned = await resolvePinnedWriteTargetInRoot(
      root,
      params.relativePath,
      params.mode,
      params.denyMutations,
      params.overwrite,
    );

    await serializePathWrite(pinned.targetPath, async () => {
      await commitPinnedWriteInRoot(root, pinned, params);
    });
  });
}

async function commitPinnedWriteInRoot(
  root: RootContext,
  pinned: PinnedWriteTarget,
  params: RootWriteOptions & { data: string | Buffer },
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
      input: { kind: "buffer", data: params.data, encoding: params.encoding },
      rootIdentity: root.rootIdentity,
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
  params: {
    sourcePath: string;
    relativePath: string;
    maxBytes?: number;
    mkdir?: boolean;
    mode?: number;
    denyMutations?: DenyMutationPolicy;
    sourceHardlinks?: HardlinkPolicy;
  },
): Promise<void> {
  assertValidRootRelativePath(params.relativePath);
  assertNoNulPathInput(params.sourcePath, "source path contains a NUL byte");
  const { opened: source, identity: sourceIdentity } = await openVerifiedLocalFile(params.sourcePath, {
    hardlinks: params.sourceHardlinks,
  });
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
        params.mode,
        params.denyMutations,
      );
      await serializePathWrite(pinned.targetPath, async () => {
        await assertCopySourceCurrent(source, sourceIdentity);
        let identity: FileIdentityStat;
        try {
          identity = await runPinnedWriteHelper({
            rootPath: pinned.rootReal,
            relativeParentPath: pinned.relativeParentPath,
            basename: pinned.basename,
            mkdir: params.mkdir !== false,
            mode: pinned.mode,
            overwrite: true,
            maxBytes: params.maxBytes,
            input: { kind: "stream", stream: source.handle.createReadStream() },
            rootIdentity: root.rootIdentity,
          });
        } catch (error) {
          throw normalizePinnedWriteError(error);
        }
        try {
          await assertCopySourcePathCurrent(source, sourceIdentity);
        } catch (error) {
          await removePathIfIdentityUnchanged(pinned.targetPath, identity).catch(() => undefined);
          throw error;
        }
      });
    });
  } finally {
    await source.handle.close().catch(() => {});
  }
}

async function assertCopySourceCurrent(source: OpenResult, identity: BigIntStats): Promise<void> {
  await inspectFileIdentity(() => fsSync.fstatSync(source.handle.fd, { bigint: true }), identity);
  await assertCopySourcePathCurrent(source, identity);
}

async function assertCopySourcePathCurrent(source: OpenResult, identity: BigIntStats): Promise<void> {
  await inspectFileIdentity(async () => {
    const current = fsSync.lstatSync(source.realPath, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new FsSafeError("path-mismatch", "copy source path changed");
    }
    return current;
  }, identity);
}

async function removePathIfIdentityUnchanged(
  targetPath: string,
  identity: FileIdentityStat,
): Promise<void> {
  const parentGuard = await createAsyncDirectoryGuard(path.dirname(targetPath));
  const current = fsSync.lstatSync(targetPath);
  if (current.isSymbolicLink() || !sameFileIdentityForCleanup(current, identity)) {
    return;
  }
  await withAsyncDirectoryGuards([parentGuard], async () => {
    await fs.rm(targetPath);
  });
}

async function resolvePinnedWriteTargetInRoot(
  root: RootContext,
  relativePath: string,
  requestedMode?: number,
  denyMutations?: DenyMutationPolicy,
  overwrite = true,
): Promise<PinnedWriteTarget> {
  const { rootReal, rootWithSep, resolved } = await resolveGuardedWritePathInRoot(root, {
    relativePath,
    denyMutations,
  });

  // resolvePathInRoot already enforces isPathInside, so any actual escape
  // is rejected upstream.
  const relativeResolved = path.relative(rootReal, resolved);
  if (path.isAbsolute(relativeResolved)) {
    throw outsideWorkspaceError();
  }
  const relativePosix = relativeResolved
    ? relativeResolved.split(path.sep).join(path.posix.sep)
    : "";
  const basename = path.posix.basename(relativePosix);
  if (!basename || basename === "." || basename === "/") {
    throw new FsSafeError("invalid-path", "invalid target path");
  }
  // Exclusive publication cannot inherit an existing file's mode. Keep type
  // and alias checks, but never open a competing owner's record just to reject it.
  if (!overwrite) {
    try {
      const existing = fsSync.statSync(resolved);
      if (!existing.isFile()) throw new FsSafeError("not-file", "not a file");
      if (existing.nlink > 1) throw hardlinkedPathNotAllowedError();
      throw new FsSafeError("already-exists", "file already exists");
    } catch (error) {
      if (!isNotFoundPathError(error)) throw error;
    }
  }
  const mode = overwrite
    ? await inheritWriteTargetMode({ targetPath: resolved, rootWithSep, requestedMode })
    : requestedMode ?? 0o600;

  return {
    rootReal,
    targetPath: resolved,
    relativeParentPath:
      path.posix.dirname(relativePosix) === "." ? "" : path.posix.dirname(relativePosix),
    basename,
    mode,
  };
}

async function resolvePinnedPathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    allowRoot?: boolean;
    denyMutations?: DenyMutationPolicy;
    remove?: boolean;
  },
): Promise<{ rootReal: string; resolved: string; relativePosix: string }> {
  return await resolvePinnedOperationPathInRoot(root, {
    allowRoot: params.allowRoot,
    denyMutations: params.denyMutations,
    protectDenyMutationAncestors: params.remove === true,
    relativePath: params.relativePath,
    policy: params.remove ? PATH_ALIAS_POLICIES.unlinkTarget : PATH_ALIAS_POLICIES.strict,
  });
}

async function resolvePinnedOperationPathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    policy: (typeof PATH_ALIAS_POLICIES)[keyof typeof PATH_ALIAS_POLICIES];
    allowRoot?: boolean;
    denyMutations?: DenyMutationPolicy;
    protectDenyMutationAncestors: boolean;
  },
): Promise<{ rootReal: string; resolved: string; relativePosix: string }> {
  const resolved = await resolvePinnedRootPathInRoot(root, {
    relativePath: params.relativePath,
    policy: params.policy,
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
  if (!isPathInside(resolved.rootWithSep, resolved.canonicalPath)) {
    throw outsideWorkspaceError();
  }
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
  },
): Promise<{ rootReal: string; rootWithSep: string; canonicalPath: string }> {
  await assertRootIdentityCurrent(root);
  const rootReal = root.rootReal;
  let resolved;
  try {
    const expandedPath = await expandRelativePathWithHome(params.relativePath);
    resolved = await resolveRootPath({
      absolutePath: path.isAbsolute(expandedPath)
        ? expandedPath
        : `${ensureTrailingSep(rootReal)}${expandedPath}`,
      rootPath: rootReal,
      rootCanonicalPath: rootReal,
      boundaryLabel: "root",
      policy: params.policy,
    });
  } catch (err) {
    throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
  }
  const rootWithSep = ensureTrailingSep(resolved.rootCanonicalPath);
  return {
    rootReal: resolved.rootCanonicalPath,
    rootWithSep,
    canonicalPath: resolved.canonicalPath,
  };
}

async function prepareRemoveGuard(targetPath: string) {
  try {
    const guard = await createAsyncDirectoryGuard(path.dirname(targetPath));
    await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("remove", targetPath);
    await assertAsyncDirectoryGuard(guard);
    return guard;
  } catch (error) {
    throw normalizeRemoveGuardError(error);
  }
}

async function removePathFallback(resolved: { resolved: string }): Promise<void> {
  const guard = await prepareRemoveGuard(resolved.resolved);
  try {
    await (fsSync.lstatSync(resolved.resolved).isDirectory() ? fs.rmdir(resolved.resolved) : fs.rm(resolved.resolved));
  } catch (error) {
    throw normalizeRemovePathError(error);
  }
  await assertAsyncDirectoryGuard(guard).catch(() => undefined);
}

async function mkdirPathFallback(resolved: { rootReal: string; resolved: string }): Promise<void> {
  await mkdirPathComponentsWithGuards({
    rootReal: resolved.rootReal, targetPath: resolved.resolved,
    beforeComponent: async (componentPath) => await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("mkdir", componentPath),
  });
}

async function statPathFallback(root: RootContext, relativePath: string): Promise<PathStat> {
  const resolved = await resolvePinnedPathInRoot(root, { relativePath, allowRoot: true });
  try {
    const stat = pathStatFromStats(fsSync.lstatSync(resolved.resolved));
    await assertRootIdentityCurrent(root);
    return stat;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw fileNotFoundError(error instanceof Error ? error : undefined);
    }
    throw error;
  }
}

async function listPathFallback(
  root: RootContext,
  relativePath: string,
  withFileTypes: boolean,
): Promise<string[] | DirEntry[]> {
  const resolved = await resolvePinnedPathInRoot(root, { relativePath, allowRoot: true });
  try {
    const names = await fs.readdir(resolved.resolved);
    const sortedNames = names.toSorted();
    if (!withFileTypes) {
      await assertRootIdentityCurrent(root);
      return sortedNames;
    }
    const entries: DirEntry[] = [];
    for (const name of sortedNames) {
      entries.push({
        name,
        ...pathStatFromStats(fsSync.lstatSync(path.join(resolved.resolved, name))),
      });
    }
    await assertRootIdentityCurrent(root);
    return entries;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw new FsSafeError("not-found", "directory not found", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    throw error;
  }
}

async function assertMoveMutationAllowed(
  root: RootContext,
  params: {
    fromRelative: string;
    toRelative: string;
    denyMutations?: DenyMutationPolicy;
  },
): Promise<void> {
  // Keep this preflight separate from the pinned resolutions in movePathFallback:
  // mutation denials must take precedence over source alias or identity failures.
  const source = await resolvePathInRoot(root, params.fromRelative, {
    aliasErrorCode: "path-alias",
    allowFinalSymlink: true,
  });
  await assertMutationNotDenied(source.resolved, params.denyMutations, { protectAncestors: true });
  const target = await resolvePathInRoot(root, params.toRelative, {
    aliasErrorCode: "path-alias",
    allowFinalSymlink: true,
  });
  await assertMutationNotDenied(target.resolved, params.denyMutations, { protectAncestors: true });
}

async function movePathFallback(
  root: RootContext,
  params: {
    fromRelative: string;
    denyMutations?: DenyMutationPolicy;
    toRelative: string;
    overwrite: boolean;
  },
): Promise<void> {
  const source = await resolvePathInRoot(root, params.fromRelative, {
    aliasErrorCode: "path-alias",
    allowFinalSymlink: true,
  });
  await assertMutationNotDenied(source.resolved, params.denyMutations, { protectAncestors: true });
  await resolvePinnedRootPathInRoot(root, {
    relativePath: params.fromRelative,
    policy: PATH_ALIAS_POLICIES.strict,
  });
  const target = await resolveGuardedWritePathInRoot(root, {
    relativePath: params.toRelative,
    denyMutations: params.denyMutations,
    allowFinalSymlink: true,
    protectDeniedAncestors: true,
    shouldAssertNoPathAlias: async (resolvedTarget) => {
      await resolvePinnedRootPathInRoot(root, {
        relativePath: params.toRelative,
        policy: PATH_ALIAS_POLICIES.unlinkTarget,
      });
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
    try {
      fsSync.lstatSync(target.resolved);
      throw new FsSafeError("already-exists", "destination exists");
    } catch (error) {
      if (error instanceof FsSafeError) {
        throw error;
      }
      if (!isNotFoundPathError(error)) {
        throw error;
      }
    }
  }

  const sourceParentGuard = await createAsyncDirectoryGuard(path.dirname(source.resolved));
  const targetParentGuard = await createNearestExistingDirectoryGuard(target.rootReal, path.dirname(target.resolved));
  await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("move", target.resolved);
  await assertAsyncDirectoryGuard(sourceParentGuard);
  await assertAsyncDirectoryGuard(targetParentGuard);
  try {
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
  await assertAsyncDirectoryGuard(targetParentGuard).catch(() => undefined);
}

async function writeFileFallback(
  root: RootContext,
  params: {
    relativePath: string;
    data: string | Buffer;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    mode?: number;
    denyMutations?: DenyMutationPolicy;
    overwrite?: boolean;
  },
): Promise<void> {
  if (params.overwrite === false) {
    await writeMissingFileFallback(root, params);
    return;
  }

  const target = await openWritableFileInRoot(root, {
    relativePath: params.relativePath,
    mkdir: params.mkdir,
    mode: params.mode,
    denyMutations: params.denyMutations,
    truncateExisting: false,
  });
  const destinationPath = target.realPath;
  const mode = params.mode ?? (target.stat.mode & 0o777);
  await target.handle.close().catch(() => {});
  const destinationGuard = await createAsyncDirectoryGuard(path.dirname(destinationPath));
  let tempPath: string | null = null;
  let unregisterTempPath: TempPathRegistration | null = null;
  let writtenHandle: FileHandle | undefined;
  try {
    tempPath = buildAtomicWriteTempPath(destinationPath);
    unregisterTempPath = registerTempPathForExit(tempPath);
    const written = await writeTempFileForAtomicReplace({
      tempPath,
      data: params.data,
      encoding: params.encoding,
      mode,
    });
    writtenHandle = written.handle;
    unregisterTempPath.setIdentity(written.identity);
    const commitTempPath = tempPath;
    await withAsyncDirectoryGuards([destinationGuard], async () => {
      await fs.rename(commitTempPath, destinationPath);
      tempPath = null;
    });
    unregisterTempPath();
    unregisterTempPath = null;
    try {
      await verifyAtomicWriteResult({
        root,
        targetPath: destinationPath,
        expectedIdentity: written.identity,
        fd: written.handle.fd,
        parentGuard: destinationGuard,
      });
    } catch (err) {
      emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
      throw err;
    }
  } finally {
    await writtenHandle?.close().catch(() => undefined);
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    unregisterTempPath?.();
  }
}

async function writeMissingFileFallback(
  root: RootContext,
  params: {
    relativePath: string;
    data: string | Buffer;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    mode?: number;
    denyMutations?: DenyMutationPolicy;
  },
): Promise<void> {
  const { rootReal, resolved } = await resolveGuardedWritePathInRoot(root, {
    relativePath: params.relativePath,
    denyMutations: params.denyMutations,
  });
  const targetPath = params.mkdir === false
    ? resolved
    : await prepareRootWriteTarget(rootReal, resolved);
  const parentGuard = await createAsyncDirectoryGuard(path.dirname(targetPath));
  let created = false;
  let createdIdentity: FileIdentityStat | undefined;
  let writtenHandle: FileHandle | undefined;
  let verifyingPublication = false;
  try {
    const { handle, writtenStat } = await withAsyncDirectoryGuards(
      [parentGuard],
      async () => {
        const handle = await fs.open(targetPath, OPEN_WRITE_CREATE_FLAGS, params.mode ?? 0o600).catch((error) => recordExclusiveCreateFailure(error, targetPath));
        created = true;
        try {
          createdIdentity = fsSync.fstatSync(handle.fd);
          const writtenStat = fsSync.fstatSync(handle.fd, { bigint: true });
          if (typeof params.data === "string") {
            await handle.writeFile(params.data, params.encoding ?? "utf8");
          } else {
            await handle.writeFile(params.data);
          }
          return { handle, writtenStat };
        } catch (error) {
          await handle.close().catch(() => undefined);
          throw error;
        }
      },
      {
        onPostGuardFailure: async ({ handle }) => {
          created = false; // Parent is untrusted now; skip outer path cleanup by name.
          await handle.close().catch(() => undefined);
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
  } catch (err) {
    if (verifyingPublication) throw err;
    if (hasNodeErrorCode(err, "EEXIST")) {
      throw new FsSafeError("already-exists", "file already exists", {
        cause: err instanceof Error ? err : undefined,
      });
    }
    throw err;
  } finally {
    await writtenHandle?.close().catch(() => undefined);
    if (created && createdIdentity) {
      await removePathIfIdentityUnchanged(targetPath, createdIdentity).catch(() => undefined);
    }
  }
}
