import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createBoundedReadStream } from "./bounded-read-stream.js";
import { assertAsyncDirectoryGuard, createAsyncDirectoryGuard, createNearestExistingDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { syncDirectoryBestEffort } from "./fsync.js";
import { sameFileIdentity } from "./file-identity.js";
import { mkdirPathComponentsWithGuards } from "./guarded-mkdir.js";
import { withAsyncDirectoryGuards } from "./guarded-mutation.js";
import {
  assertMutationNotDenied,
  mergeDenyMutationPolicies,
  type DenyMutationPolicy,
} from "./deny-mutations.js";
import { resolveOpenedFileRealPathForHandle } from "./opened-realpath.js";
import { isPinnedPathHelperSpawnError, runPinnedPathHelper } from "./pinned-path.js";
import { runPinnedCopyHelper, runPinnedWriteHelper } from "./pinned-write.js";
import { canFallbackFromPythonError, getFsSafePythonConfig } from "./pinned-python-config.js";
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
import {
  helperReaddir,
  helperStat,
  runPinnedHelper,
} from "./pinned-helper.js";
import { pathStatFromStats } from "./path-stat.js";
import { resolveRootPath } from "./root-path.js";
import {
  assertValidRootRelativePath,
  ensureTrailingSep,
  expandRelativePathWithHome,
  resolvePathInRoot,
  resolveRootContext,
  type RootContext,
} from "./root-context.js";
import {
  isAlreadyExistsError,
  normalizePinnedPathError,
  normalizePinnedWriteError,
} from "./root-errors.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import type { DirEntry, PathStat } from "./types.js";
import { registerTempPathForExit } from "./temp-cleanup.js";
import { withSidecarLock } from "./sidecar-lock.js";
import { serializePathWrite } from "./write-queue.js";

export type { DenyMutationPolicy } from "./deny-mutations.js";
export { resolveOpenedFileRealPathForHandle } from "./opened-realpath.js";
export type { ReadResult } from "./read-opened-file.js";

export type OpenResult = {
  handle: FileHandle;
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

export type RenameIdentityPolicy = "strict" | "verify-content-with-lock";

export type RootDefaults = {
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

export type RootWriteOptions = Pick<RootDefaults, "denyMutations" | "mkdir" | "mode" | "renameIdentity"> & {
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

type RootReadParams = RootReadOptions;

function logWarn(message: string): void {
  if (process.env.FS_SAFE_DEBUG_WARNINGS === "1") {
    console.warn(message);
  }
}

const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const NONBLOCK_OPEN_FLAG = "O_NONBLOCK" in fsConstants ? fsConstants.O_NONBLOCK : 0;
const OPEN_READ_FLAGS = fsConstants.O_RDONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_READ_NONBLOCK_FLAGS = OPEN_READ_FLAGS | NONBLOCK_OPEN_FLAG;
const OPEN_READ_FOLLOW_FLAGS = fsConstants.O_RDONLY;
const OPEN_READ_FOLLOW_NONBLOCK_FLAGS = OPEN_READ_FOLLOW_FLAGS | NONBLOCK_OPEN_FLAG;
const OPEN_WRITE_EXISTING_FLAGS =
  fsConstants.O_WRONLY | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_WRITE_CREATE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_APPEND_EXISTING_FLAGS =
  fsConstants.O_RDWR | fsConstants.O_APPEND | (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);
const OPEN_APPEND_CREATE_FLAGS =
  fsConstants.O_RDWR |
  fsConstants.O_APPEND |
  fsConstants.O_CREAT |
  fsConstants.O_EXCL |
  (SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0);

export const DEFAULT_ROOT_MAX_BYTES = 16 * 1024 * 1024;

function openResult(params: {
  handle: FileHandle;
  realPath: string;
  stat: Stats;
}): OpenResult {
  return {
    handle: params.handle,
    realPath: params.realPath,
    stat: params.stat,
    [Symbol.asyncDispose]: () => params.handle.close().catch(() => undefined),
  };
}

async function openVerifiedLocalFile(
  filePath: string,
  options?: {
    hardlinks?: HardlinkPolicy;
    nonBlockingRead?: boolean;
    symlinks?: SymlinkPolicy;
  },
): Promise<OpenResult> {
  assertNoUnsafeDeviceReadPath(filePath);
  const fsSafeTestHooks = getFsSafeTestHooks();
  // Reject directories before opening so we never surface EISDIR to callers (e.g. tool
  // results that get sent to messaging channels). See openclaw/openclaw#31186.
  try {
    const preStat = await fs.lstat(filePath);
    if (preStat.isDirectory()) {
      throw new FsSafeError("not-file", "not a file");
    }
    await fsSafeTestHooks?.afterPreOpenLstat?.(filePath);
  } catch (err) {
    if (err instanceof FsSafeError) {
      throw err;
    }
    // ENOENT and other lstat errors: fall through and let fs.open handle.
  }

  let handle: FileHandle;
  try {
    const openFlags = options?.symlinks === "follow-within-root"
      ? options?.nonBlockingRead
        ? OPEN_READ_FOLLOW_NONBLOCK_FLAGS
        : OPEN_READ_FOLLOW_FLAGS
      : options?.nonBlockingRead
        ? OPEN_READ_NONBLOCK_FLAGS
        : OPEN_READ_FLAGS;
    await fsSafeTestHooks?.beforeOpen?.(filePath, openFlags);
    handle = await fs.open(filePath, openFlags);
    try {
      await fsSafeTestHooks?.afterOpen?.(filePath, handle);
    } catch (err) {
      await handle.close().catch(() => {});
      throw err;
    }
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new FsSafeError("not-found", "file not found");
    }
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
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new FsSafeError("not-file", "not a file");
    }
    if (options?.hardlinks === "reject" && stat.nlink > 1) {
      throw new FsSafeError("hardlink", "hardlinked path not allowed");
    }

    if (options?.symlinks === "follow-within-root") {
      const pathStat = await fs.stat(filePath);
      if (!sameFileIdentity(stat, pathStat)) {
        throw new FsSafeError("path-mismatch", "path changed during read");
      }
    } else {
      const pathStat = await fs.lstat(filePath);
      if (pathStat.isSymbolicLink()) {
        throw new FsSafeError("symlink", "symlink not allowed");
      }
      if (!sameFileIdentity(stat, pathStat)) {
        throw new FsSafeError("path-mismatch", "path changed during read");
      }
    }

    const realPath = await resolveOpenedFileRealPathForHandle(handle, filePath);
    const realStat = await fs.stat(realPath);
    if (options?.hardlinks === "reject" && realStat.nlink > 1) {
      throw new FsSafeError("hardlink", "hardlinked path not allowed");
    }
    if (!sameFileIdentity(stat, realStat)) {
      throw new FsSafeError("path-mismatch", "path mismatch");
    }

    return openResult({ handle, realPath, stat });
  } catch (err) {
    await handle.close().catch(() => {});
    if (err instanceof FsSafeError) {
      throw err;
    }
    if (isNotFoundPathError(err)) {
      throw new FsSafeError("not-found", "file not found");
    }
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
}

class RootHandle implements Root {
  readonly rootDir: string;
  readonly rootReal: string;
  readonly rootWithSep: string;
  readonly defaults: RootDefaults;

  constructor(context: RootContext, defaults: RootDefaults = {}) {
    this.rootDir = context.rootDir;
    this.rootReal = context.rootReal;
    this.rootWithSep = context.rootWithSep;
    this.defaults = defaults;
  }

  private get context(): RootContext {
    return {
      rootDir: this.rootDir,
      rootReal: this.rootReal,
      rootWithSep: this.rootWithSep,
    };
  }

  async resolve(relativePath: string): Promise<string> {
    return (await resolvePathInRoot(this.context, relativePath)).resolved;
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
      ...readDefaults(this.defaults),
      ...options,
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
      ...readDefaults(this.defaults),
      ...options,
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
    const writeMode = options.writeMode ?? "replace";
    return await openWritableFileInRoot(this.context, {
      relativePath,
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      ...options,
      denyMutations: mergeDenyMutationPolicies(this.defaults.denyMutations, options.denyMutations),
      append: writeMode === "append",
      truncateExisting: writeMode === "replace",
    });
  }

  async append(relativePath: string, data: string | Buffer, options: RootAppendOptions = {}): Promise<void> {
    await appendFileInRoot(this.context, {
      relativePath,
      data,
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      ...options,
      denyMutations: mergeDenyMutationPolicies(this.defaults.denyMutations, options.denyMutations),
    });
  }

  async remove(relativePath: string, options: RootRemoveOptions = {}): Promise<void> {
    assertValidRootRelativePath(relativePath);
    await removePathInRoot(this.context, {
      relativePath,
      denyMutations: mergeDenyMutationPolicies(this.defaults.denyMutations, options.denyMutations),
    });
  }

  async mkdir(relativePath: string, options: RootMkdirOptions = {}): Promise<void> {
    assertValidRootRelativePath(relativePath);
    await mkdirPathInRoot(this.context, {
      relativePath,
      denyMutations: mergeDenyMutationPolicies(this.defaults.denyMutations, options.denyMutations),
    });
  }

  async ensureRoot(options: RootMkdirOptions = {}): Promise<void> {
    await mkdirPathInRoot(this.context, {
      relativePath: "",
      allowRoot: true,
      denyMutations: mergeDenyMutationPolicies(this.defaults.denyMutations, options.denyMutations),
    });
  }

  async write(
    relativePath: string,
    data: string | Buffer,
    options: RootWriteOptions = {},
  ): Promise<void> {
    await writeFileInRoot(this.context, {
      relativePath,
      data,
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      renameIdentity: this.defaults.renameIdentity,
      ...options,
      denyMutations: mergeDenyMutationPolicies(this.defaults.denyMutations, options.denyMutations),
    });
  }

  async create(
    relativePath: string,
    data: string | Buffer,
    options: RootCreateOptions = {},
  ): Promise<void> {
    await writeFileInRoot(this.context, {
      relativePath,
      data,
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      ...options,
      denyMutations: mergeDenyMutationPolicies(this.defaults.denyMutations, options.denyMutations),
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
    assertValidRootRelativePath(relativePath);
    await copyFileInRoot(this.context, {
      sourcePath,
      relativePath,
      maxBytes: this.defaults.maxBytes,
      mkdir: this.defaults.mkdir,
      mode: this.defaults.mode,
      ...options,
      denyMutations: mergeDenyMutationPolicies(this.defaults.denyMutations, options.denyMutations),
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
    try {
      return await helperStat(this.rootReal, relativePath);
    } catch (error) {
      if (canFallbackFromPythonError(error)) {
        return await statPathFallback(this.context, relativePath);
      }
      throw error;
    }
  }

  async list(relativePath: string, options?: { withFileTypes?: false }): Promise<string[]>;
  async list(relativePath: string, options: { withFileTypes: true }): Promise<DirEntry[]>;
  async list(
    relativePath: string,
    options: { withFileTypes?: boolean } = {},
  ): Promise<string[] | DirEntry[]> {
    assertValidRootRelativePath(relativePath);
    try {
      return options.withFileTypes === true
        ? await helperReaddir(this.rootReal, relativePath, true)
        : await helperReaddir(this.rootReal, relativePath, false);
    } catch (error) {
      if (canFallbackFromPythonError(error)) {
        return await listPathFallback(this.context, relativePath, options.withFileTypes === true);
      }
      throw error;
    }
  }

  async move(
    fromRelative: string,
    toRelative: string,
    options: RootMoveOptions = {},
  ): Promise<void> {
    assertValidRootRelativePath(fromRelative);
    assertValidRootRelativePath(toRelative);
    const denyMutations = mergeDenyMutationPolicies(
      this.defaults.denyMutations,
      options.denyMutations,
    );
    await assertMoveMutationAllowed(this.context, {
      fromRelative,
      toRelative,
      denyMutations,
    });
    try {
      await runPinnedHelper<void>("rename", this.rootReal, {
        from: fromRelative,
        overwrite: options.overwrite ?? false,
        to: toRelative,
      });
    } catch (error) {
      if (canFallbackFromPythonError(error)) {
        await movePathFallback(this.context, {
          fromRelative,
          denyMutations,
          overwrite: options.overwrite ?? false,
          toRelative,
        });
        return;
      }
      throw error;
    }
  }
}

function readDefaults(defaults: RootDefaults): RootReadParams {
  return {
    hardlinks: defaults.hardlinks,
    maxBytes: defaults.maxBytes ?? DEFAULT_ROOT_MAX_BYTES,
    nonBlockingRead: defaults.nonBlockingRead,
    symlinks: defaults.symlinks,
  };
}

export async function root(
  rootDir: string,
  defaults: RootDefaults = {},
): Promise<Root> {
  return new RootHandle(await resolveRootContext(rootDir), defaults);
}

async function openFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    hardlinks?: HardlinkPolicy;
    nonBlockingRead?: boolean;
    symlinks?: SymlinkPolicy;
  },
): Promise<OpenResult> {
  const { rootWithSep, resolved } = await resolvePathInRoot(root, params.relativePath);

  let opened: OpenResult;
  try {
    opened = await openVerifiedLocalFile(resolved, {
      nonBlockingRead: params.nonBlockingRead,
      symlinks: params.symlinks,
    });
  } catch (err) {
    if (err instanceof FsSafeError) {
      throw err;
    }
    throw err;
  }

  if (params.hardlinks !== "allow" && opened.stat.nlink > 1) {
    await opened.handle.close().catch(() => {});
    throw new FsSafeError("hardlink", "hardlinked path not allowed");
  }

  if (!isPathInside(rootWithSep, opened.realPath)) {
    await opened.handle.close().catch(() => {});
    throw new FsSafeError("outside-workspace", "file is outside workspace root");
  }

  return opened;
}

async function readFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    hardlinks?: HardlinkPolicy;
    nonBlockingRead?: boolean;
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
    nonBlockingRead?: boolean;
    symlinks?: SymlinkPolicy;
  },
): Promise<ReadResult> {
  const rootDir = root.rootDir;
  const candidatePath = path.isAbsolute(params.filePath)
    ? path.resolve(params.filePath)
    : path.resolve(rootDir, params.filePath);
  const relativePath = path.relative(rootDir, candidatePath);
  return await readFileInRoot(root, {
    relativePath,
    hardlinks: params.hardlinks,
    maxBytes: params.maxBytes,
    nonBlockingRead: params.nonBlockingRead,
    symlinks: params.symlinks,
  });
}

export async function readLocalFileSafely(params: {
  filePath: string;
  maxBytes?: number;
}): Promise<ReadResult> {
  const opened = await openLocalFileSafely({ filePath: params.filePath });
  try {
    return await readOpenedFileSafely({ opened, maxBytes: params.maxBytes });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

export async function openLocalFileSafely(params: { filePath: string }): Promise<OpenResult> {
  assertNoNulPathInput(params.filePath, "file path contains a NUL byte");
  return await openVerifiedLocalFile(params.filePath);
}

export type WritableOpenResult = {
  handle: FileHandle;
  createdForWrite: boolean;
  realPath: string;
  stat: Stats;
  [Symbol.asyncDispose](): Promise<void>;
};

function emitWriteBoundaryWarning(reason: string) {
  logWarn(`security: fs-safe write boundary warning (${reason})`);
}

function buildAtomicWriteTempPath(targetPath: string): string {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  return path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
}

function rootWriteQueueKey(root: RootContext, relativePath: string): string {
  return `${root.rootReal}\0${relativePath}`;
}

type PinnedWriteTarget = { rootReal: string; targetPath: string; relativeParentPath: string; basename: string; mode: number };

async function writeTempFileForAtomicReplace(params: {
  tempPath: string;
  data: string | Buffer;
  encoding?: BufferEncoding;
  mode: number;
}): Promise<Stats> {
  const tempHandle = await fs.open(params.tempPath, OPEN_WRITE_CREATE_FLAGS, params.mode);
  try {
    if (typeof params.data === "string") {
      await tempHandle.writeFile(params.data, params.encoding ?? "utf8");
    } else {
      await tempHandle.writeFile(params.data);
    }
    return await tempHandle.stat();
  } finally {
    await tempHandle.close().catch(() => {});
  }
}

async function verifyAtomicWriteResult(params: {
  root: RootContext;
  targetPath: string;
  expectedIdentity: { dev: number | bigint; ino: number | bigint };
}): Promise<void> {
  const opened = await openVerifiedLocalFile(params.targetPath, { hardlinks: "reject" });
  try {
    if (!sameFileIdentity(opened.stat, params.expectedIdentity)) {
      throw new FsSafeError("path-mismatch", "path changed during write");
    }
    if (!isPathInside(params.root.rootWithSep, opened.realPath)) {
      throw new FsSafeError("outside-workspace", "file is outside workspace root");
    }
  } finally {
    await opened.handle.close().catch(() => {});
  }
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
  const { rootReal, rootWithSep, resolved } = await resolvePathInRoot(
    root,
    params.relativePath,
  );
  await assertMutationNotDenied(resolved, params.denyMutations);
  try {
    await assertNoPathAliasEscape({
      absolutePath: resolved,
      rootPath: rootReal,
      boundaryLabel: "root",
    });
  } catch (err) {
    throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
  }
  if (params.mkdir !== false) {
    const parentGuard = await createNearestExistingDirectoryGuard(rootReal, path.dirname(resolved));
    await withAsyncDirectoryGuards([parentGuard], async () => {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
    });
  }

  let ioPath = resolved;
  try {
    const resolvedRealPath = await fs.realpath(resolved);
    if (!isPathInside(rootWithSep, resolvedRealPath)) {
      throw new FsSafeError("outside-workspace", "file is outside workspace root");
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
      if (!isNotFoundPathError(err)) {
        throw err;
      }
      handle = await fs.open(ioPath, createFlags, mode);
      createdForWrite = true;
    }
  } catch (err) {
    if (isNotFoundPathError(err)) {
      throw new FsSafeError("not-found", "file not found");
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
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new FsSafeError("invalid-path", "path is not a regular file under root");
    }
    if (stat.nlink > 1) {
      throw new FsSafeError("hardlink", "hardlinked path not allowed");
    }

    try {
      const lstat = await fs.lstat(ioPath);
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
    const realStat = await fs.stat(realPath);
    if (!sameFileIdentity(stat, realStat)) {
      throw new FsSafeError("path-mismatch", "path mismatch");
    }
    if (realStat.nlink > 1) {
      throw new FsSafeError("hardlink", "hardlinked path not allowed");
    }
    if (!isPathInside(rootWithSep, realPath)) {
      throw new FsSafeError("outside-workspace", "file is outside workspace root");
    }

    // Truncate only after boundary and identity checks complete. This avoids
    // irreversible side effects if a symlink target changes before validation.
    if (params.append !== true && params.truncateExisting !== false && !createdForWrite) {
      await handle.truncate(0);
    }
    return {
      handle,
      createdForWrite,
      realPath,
      stat,
      [Symbol.asyncDispose]: () => handle.close().catch(() => undefined),
    };
  } catch (err) {
    const cleanupCreatedPath = createdForWrite && err instanceof FsSafeError;
    const cleanupPath = realPathForCleanup ?? ioPath;
    await handle.close().catch(() => {});
    if (cleanupCreatedPath) {
      await fs.rm(cleanupPath, { force: true }).catch(() => {});
    }
    throw err;
  }
}

async function appendFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    data: string | Buffer;
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
    await target.handle.sync();
    if (target.createdForWrite) {
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
  const resolved = await resolvePinnedRemovePathInRoot(
    root,
    params.relativePath,
    params.denyMutations,
  );
  if (process.platform === "win32") {
    await removePathFallback(resolved);
    return;
  }
  try {
    await runPinnedPathHelper({
      operation: "remove",
      rootPath: resolved.rootReal,
      relativePath: resolved.relativePosix,
    });
  } catch (error) {
    if (isPinnedPathHelperSpawnError(error)) {
      await removePathFallback(resolved);
      return;
    }
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
  const resolved = await resolvePinnedPathInRoot(root, params);
  if (process.platform === "win32") {
    await mkdirPathFallback(resolved);
    return;
  }
  try {
    await runPinnedPathHelper({
      operation: "mkdirp",
      rootPath: resolved.rootReal,
      relativePath: resolved.relativePosix,
    });
  } catch (error) {
    if (isPinnedPathHelperSpawnError(error)) {
      await mkdirPathFallback(resolved);
      return;
    }
    throw normalizePinnedPathError(error);
  }
}

async function writeFileInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    data: string | Buffer;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    mode?: number;
    denyMutations?: DenyMutationPolicy;
    overwrite?: boolean;
    renameIdentity?: RenameIdentityPolicy;
  },
): Promise<void> {
  if (process.platform === "win32") {
    await serializePathWrite(rootWriteQueueKey(root, params.relativePath), async () => {
      await writeFileFallback(root, params);
    });
    return;
  }

  const pinned = await resolvePinnedWriteTargetInRoot(
    root,
    params.relativePath,
    params.mode,
    params.denyMutations,
  );

  await serializePathWrite(pinned.targetPath, async () => {
    await commitPinnedWriteInRoot(root, pinned, params);
  });
}

function lockHolderIsAlive(payload: Record<string, unknown> | null): boolean {
  const pid = Number(payload?.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    // No valid PID in payload — cannot determine liveness. Treat as alive so
    // we don't aggressively reclaim a lock whose holder we cannot identify.
    return true;
  }
  try {
    // Signal 0 does not kill the process; it checks whether we have permission
    // to send signals to pid. Throws ESRCH if the process does not exist.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but we cannot signal it — treat as alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function commitPinnedWriteInRoot(
  root: RootContext,
  pinned: PinnedWriteTarget,
  params: {
    data: string | Buffer;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    mode?: number;
    overwrite?: boolean;
    renameIdentity?: RenameIdentityPolicy;
  },
): Promise<void> {
  const helperParams = {
    rootPath: pinned.rootReal,
    relativeParentPath: pinned.relativeParentPath,
    basename: pinned.basename,
    mkdir: params.mkdir !== false,
    mode: params.mode ?? pinned.mode,
    overwrite: params.overwrite,
    input: { kind: "buffer" as const, data: params.data, encoding: params.encoding },
  };

  let identity;

  if (params.renameIdentity === "verify-content-with-lock") {
    // On FUSE mounts where rename(2) causes inode-churn, hold a cooperative
    // sidecar lock for the entire write so content-hash verification is
    // meaningful. If the holder crashes, the PID-liveness check reclaims the
    // stale lock immediately rather than after a fixed timeout.
    await withSidecarLock(
      pinned.targetPath,
      {
        managerKey: `fs-safe.write:${pinned.targetPath}`,
        staleMs: 30_000,
        payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
        retry: { retries: 5, minTimeout: 100, maxTimeout: 2_000, factor: 2 },
        shouldReclaim: ({ payload }) => !lockHolderIsAlive(payload),
        staleRecovery: "remove-if-unchanged",
        shouldRemoveStaleLock: ({ payload }) => !lockHolderIsAlive(payload),
      },
      async () => {
        try {
          identity = await runPinnedWriteHelper({
            ...helperParams,
            onRenameIdentityMismatch: "verify-content",
          });
        } catch (error) {
          throw normalizePinnedWriteError(error);
        }
      },
    );
  } else {
    try {
      identity = await runPinnedWriteHelper(helperParams);
    } catch (error) {
      if (params.overwrite === false && isAlreadyExistsError(error)) {
        throw new FsSafeError("already-exists", "file already exists", {
          cause: error instanceof Error ? error : undefined,
        });
      }
      throw normalizePinnedWriteError(error);
    }
  }

  try {
    await verifyAtomicWriteResult({
      root,
      targetPath: pinned.targetPath,
      expectedIdentity: identity!,
    });
  } catch (err) {
    emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
    throw err;
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
  const source = await openVerifiedLocalFile(params.sourcePath, {
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
    if (process.platform === "win32") {
      await serializePathWrite(rootWriteQueueKey(root, params.relativePath), async () => {
        await copyFileFallback(root, params, source);
      });
      return;
    }

    const pinned = await resolvePinnedWriteTargetInRoot(
      root,
      params.relativePath,
      params.mode,
      params.denyMutations,
    );
    await serializePathWrite(pinned.targetPath, async () => {
      let identity;
      try {
        if (getFsSafePythonConfig().mode === "off") {
          await copyFileFallback(root, params, source);
          return;
        }
        identity = await runPinnedCopyHelper({
          rootPath: pinned.rootReal,
          relativeParentPath: pinned.relativeParentPath,
          basename: pinned.basename,
          mkdir: params.mkdir !== false,
          mode: pinned.mode,
          overwrite: true,
          maxBytes: params.maxBytes,
          sourcePath: source.realPath,
          sourceIdentity: { dev: source.stat.dev, ino: source.stat.ino },
        });
      } catch (error) {
        if (canFallbackFromPythonError(error)) {
          await copyFileFallback(root, params, source);
          return;
        }
        throw normalizePinnedWriteError(error);
      }
      try {
        await verifyAtomicWriteResult({
          root,
          targetPath: pinned.targetPath,
          expectedIdentity: identity,
        });
      } catch (err) {
        emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
        throw err;
      }
    });
  } finally {
    await source.handle.close().catch(() => {});
  }
}

async function resolvePinnedWriteTargetInRoot(
  root: RootContext,
  relativePath: string,
  requestedMode?: number,
  denyMutations?: DenyMutationPolicy,
): Promise<PinnedWriteTarget> {
  const { rootReal, rootWithSep, resolved } = await resolvePathInRoot(root, relativePath);
  await assertMutationNotDenied(resolved, denyMutations);
  try {
    await assertNoPathAliasEscape({
      absolutePath: resolved,
      rootPath: rootReal,
      boundaryLabel: "root",
    });
  } catch (err) {
    throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
  }

  // resolvePathInRoot already enforces isPathInside, so any actual escape
  // is rejected upstream.
  const relativeResolved = path.relative(rootReal, resolved);
  if (path.isAbsolute(relativeResolved)) {
    throw new FsSafeError("outside-workspace", "file is outside workspace root");
  }
  const relativePosix = relativeResolved
    ? relativeResolved.split(path.sep).join(path.posix.sep)
    : "";
  const basename = path.posix.basename(relativePosix);
  if (!basename || basename === "." || basename === "/") {
    throw new FsSafeError("invalid-path", "invalid target path");
  }
  let mode = requestedMode ?? 0o600;
  try {
    const opened = await openFileInRoot(root, {
      relativePath,
      hardlinks: "reject",
      nonBlockingRead: true,
    });
    try {
      mode = requestedMode ?? (opened.stat.mode & 0o777);
      if (!isPathInside(rootWithSep, opened.realPath)) {
        throw new FsSafeError("outside-workspace", "file is outside workspace root");
      }
    } finally {
      await opened.handle.close().catch(() => {});
    }
  } catch (err) {
    if (!(err instanceof FsSafeError) || err.code !== "not-found") {
      throw err;
    }
  }

  return {
    rootReal,
    targetPath: resolved,
    relativeParentPath:
      path.posix.dirname(relativePosix) === "." ? "" : path.posix.dirname(relativePosix),
    basename,
    mode: mode || 0o600,
  };
}

async function resolvePinnedPathInRoot(
  root: RootContext,
  params: {
    relativePath: string;
    allowRoot?: boolean;
    denyMutations?: DenyMutationPolicy;
  },
): Promise<{ rootReal: string; resolved: string; relativePosix: string }> {
  return await resolvePinnedOperationPathInRoot(root, {
    allowRoot: params.allowRoot,
    denyMutations: params.denyMutations,
    protectDenyMutationAncestors: false,
    relativePath: params.relativePath,
    policy: PATH_ALIAS_POLICIES.strict,
  });
}

async function resolvePinnedRemovePathInRoot(
  root: RootContext,
  relativePath: string,
  denyMutations?: DenyMutationPolicy,
): Promise<{ rootReal: string; resolved: string; relativePosix: string }> {
  return await resolvePinnedOperationPathInRoot(root, {
    denyMutations,
    protectDenyMutationAncestors: true,
    relativePath,
    policy: PATH_ALIAS_POLICIES.unlinkTarget,
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
    throw new FsSafeError("outside-workspace", "file is outside workspace root");
  }
  const relativePosix = relativeResolved.split(path.sep).join(path.posix.sep);
  if (!isPathInside(resolved.rootWithSep, resolved.canonicalPath)) {
    throw new FsSafeError("outside-workspace", "file is outside workspace root");
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
  const rootReal = root.rootReal;
  let resolved;
  try {
    resolved = await resolveRootPath({
      absolutePath: path.resolve(rootReal, await expandRelativePathWithHome(params.relativePath)),
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

async function removePathFallback(resolved: { resolved: string }): Promise<void> {
  const guard = await createAsyncDirectoryGuard(path.dirname(resolved.resolved));
  await getFsSafeTestHooks()?.beforeRootFallbackMutation?.("remove", resolved.resolved);
  await assertAsyncDirectoryGuard(guard);
  await ((await fs.lstat(resolved.resolved)).isDirectory() ? fs.rmdir(resolved.resolved) : fs.rm(resolved.resolved));
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
    return pathStatFromStats(await fs.lstat(resolved.resolved));
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw new FsSafeError("not-found", "file not found", {
        cause: error instanceof Error ? error : undefined,
      });
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
      return sortedNames;
    }
    const entries: DirEntry[] = [];
    for (const name of sortedNames) {
      entries.push({
        name,
        ...pathStatFromStats(await fs.lstat(path.join(resolved.resolved, name))),
      });
    }
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
  const source = await resolvePathInRoot(root, params.fromRelative);
  await assertMutationNotDenied(source.resolved, params.denyMutations, { protectAncestors: true });
  const target = await resolvePathInRoot(root, params.toRelative);
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
  const source = await resolvePathInRoot(root, params.fromRelative);
  await assertMutationNotDenied(source.resolved, params.denyMutations, { protectAncestors: true });
  await resolvePinnedRootPathInRoot(root, {
    relativePath: params.fromRelative,
    policy: PATH_ALIAS_POLICIES.strict,
  });
  const target = await resolvePathInRoot(root, params.toRelative);
  await assertMutationNotDenied(target.resolved, params.denyMutations, { protectAncestors: true });
  await resolvePinnedRootPathInRoot(root, {
    relativePath: params.toRelative,
    policy: PATH_ALIAS_POLICIES.unlinkTarget,
  });
  try {
    await assertNoPathAliasEscape({
      absolutePath: target.resolved,
      rootPath: target.rootReal,
      boundaryLabel: "root",
    });
  } catch (error) {
    throw new FsSafeError("path-alias", "path alias escape blocked", {
      cause: error instanceof Error ? error : undefined,
    });
  }

  let sourceStat: Stats;
  try {
    sourceStat = await fs.lstat(source.resolved);
  } catch (error) {
    if (isNotFoundPathError(error)) {
      throw new FsSafeError("not-found", "file not found", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    throw error;
  }
  if (sourceStat.isSymbolicLink()) {
    throw new FsSafeError("symlink", "symlink not allowed");
  }
  if (sourceStat.isFile() && sourceStat.nlink > 1) {
    throw new FsSafeError("hardlink", "hardlinked path not allowed");
  }
  if (!params.overwrite && sourceStat.isDirectory()) {
    throw new FsSafeError("invalid-path", "directory moves require overwrite: true");
  }
  if (!params.overwrite) {
    try {
      await fs.lstat(target.resolved);
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
      throw new FsSafeError("not-found", "file not found", {
        cause: error instanceof Error ? error : undefined,
      });
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
  let unregisterTempPath: (() => void) | null = null;
  try {
    tempPath = buildAtomicWriteTempPath(destinationPath);
    unregisterTempPath = registerTempPathForExit(tempPath);
    const writtenStat = await writeTempFileForAtomicReplace({
      tempPath,
      data: params.data,
      encoding: params.encoding,
      mode: mode || 0o600,
    });
    const commitTempPath = tempPath;
    await withAsyncDirectoryGuards([destinationGuard], async () => {
      await fs.rename(commitTempPath, destinationPath);
    });
    tempPath = null;
    unregisterTempPath();
    unregisterTempPath = null;
    try {
      await verifyAtomicWriteResult({
        root,
        targetPath: destinationPath,
        expectedIdentity: writtenStat,
      });
    } catch (err) {
      emitWriteBoundaryWarning(`post-write verification failed: ${String(err)}`);
      throw err;
    }
  } finally {
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
  const { rootReal, resolved } = await resolvePathInRoot(root, params.relativePath);
  await assertMutationNotDenied(resolved, params.denyMutations);
  try {
    await assertNoPathAliasEscape({
      absolutePath: resolved,
      rootPath: rootReal,
      boundaryLabel: "root",
    });
  } catch (err) {
    throw new FsSafeError("path-alias", "path alias escape blocked", { cause: err });
  }
  if (params.mkdir !== false) {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
  }
  const parentGuard = await createAsyncDirectoryGuard(path.dirname(resolved));
  let created = false;
  try {
    const { handle, writtenStat } = await withAsyncDirectoryGuards(
      [parentGuard],
      async () => {
        const handle = await fs.open(resolved, OPEN_WRITE_CREATE_FLAGS, params.mode ?? 0o600);
        created = true;
        try {
          if (typeof params.data === "string") {
            await handle.writeFile(params.data, params.encoding ?? "utf8");
          } else {
            await handle.writeFile(params.data);
          }
          return { handle, writtenStat: await handle.stat() };
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
    await handle.close();
    await verifyAtomicWriteResult({
      root,
      targetPath: resolved,
      expectedIdentity: writtenStat,
    });
    created = false;
  } catch (err) {
    if (hasNodeErrorCode(err, "EEXIST")) {
      throw new FsSafeError("already-exists", "file already exists", {
        cause: err instanceof Error ? err : undefined,
      });
    }
    throw err;
  } finally {
    if (created) {
      await fs.rm(resolved, { force: true }).catch(() => undefined);
    }
  }
}

async function copyFileFallback(
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
  source: OpenResult,
): Promise<void> {
  let target: WritableOpenResult | null = null;
  let sourceClosedByStream = false;
  let targetClosedByUs = false;
  let tempHandle: FileHandle | null = null;
  let tempPath: string | null = null;
  let unregisterTempPath: (() => void) | null = null;
  let tempClosedByStream = false;
  try {
    target = await openWritableFileInRoot(root, {
      relativePath: params.relativePath,
      mkdir: params.mkdir,
      mode: params.mode,
      denyMutations: params.denyMutations,
      truncateExisting: false,
    });
    const destinationPath = target.realPath;
    const mode = params.mode ?? (target.stat.mode & 0o777);
    await target.handle.close().catch(() => {});
    targetClosedByUs = true;
    const destinationGuard = await createAsyncDirectoryGuard(path.dirname(destinationPath));

    tempPath = buildAtomicWriteTempPath(destinationPath);
    unregisterTempPath = registerTempPathForExit(tempPath);
    tempHandle = await fs.open(tempPath, OPEN_WRITE_CREATE_FLAGS, mode || 0o600);
    const sourceStream = createBoundedReadStream(source, params.maxBytes);
    const targetStream = tempHandle.createWriteStream();
    sourceStream.once("close", () => {
      sourceClosedByStream = true;
    });
    targetStream.once("close", () => {
      tempClosedByStream = true;
    });
    await pipeline(sourceStream, targetStream);
    const writtenStat = await fs.stat(tempPath);
    if (!tempClosedByStream) {
      await tempHandle.close().catch(() => {});
      tempClosedByStream = true;
    }
    tempHandle = null;
    const commitTempPath = tempPath;
    await withAsyncDirectoryGuards([destinationGuard], async () => {
      await fs.rename(commitTempPath, destinationPath);
    });
    tempPath = null;
    unregisterTempPath();
    unregisterTempPath = null;
    try {
      await verifyAtomicWriteResult({
        root,
        targetPath: destinationPath,
        expectedIdentity: writtenStat,
      });
    } catch (err) {
      emitWriteBoundaryWarning(`post-copy verification failed: ${String(err)}`);
      throw err;
    }
  } catch (err) {
    if (target?.createdForWrite) {
      await fs.rm(target.realPath, { force: true }).catch(() => {});
    }
    throw err;
  } finally {
    if (!sourceClosedByStream) {
      await source.handle.close().catch(() => {});
    }
    if (tempHandle && !tempClosedByStream) {
      await tempHandle.close().catch(() => {});
    }
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    unregisterTempPath?.();
    if (target && !targetClosedByUs) {
      await target.handle.close().catch(() => {});
    }
  }
}
