import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { normalizeMaxBytes } from "./byte-budget.js";
import { readFileDescriptorBoundedSync } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
import { assertFileStoreMaxBytes } from "./file-store-limit.js";
import { assertRelativePath, resolveStorePath } from "./file-store-path.js";
import { pruneExpiredStoreEntries, type FileStorePruneOptions } from "./file-store-prune.js";
export type { FileStorePruneOptions } from "./file-store-prune.js";
import {
  ensureParentInRoot,
  openPrivateStoreLockRoot,
  openWritableStoreRoot,
  writeStreamToTempSource,
} from "./file-store-boundary.js";
import { writeFileSyncAtomic } from "./file-store-sync-write.js";
import { createJsonStore, type JsonFileStoreOptions, type JsonStore } from "./json-document-store.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import { isNotFoundPathError } from "./path.js";
import { throwFsSafeReadError } from "./root-errors.js";
import { root, type OpenResult, type ReadResult, type Root, type RootReadOptions } from "./root.js";
import { DEFAULT_ROOT_MAX_BYTES } from "./root-impl.js";
import { matchRootFileOpenFailure, openRootFileSync, type RootFileOpenFailure } from "./root-file.js";
import { writeSecretFileAtomic } from "./secret-file.js";
import {
  assertNoWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";
import { readFileStoreCopySource } from "./file-store-copy-source.js";

export type FileStoreOptions = {
  rootDir: string;
  private?: boolean;
  /** Default for writes, streams, and copies; true syncs file and parent where supported. */
  durable?: boolean;
  dirMode?: number;
  mode?: number;
  maxBytes?: number;
};

export type FileStoreWriteOptions = {
  /** Override store durability; defaults to the store option, then true. */
  durable?: boolean;
  dirMode?: number;
  mode?: number;
  maxBytes?: number;
  tempPrefix?: string;
};

function snapshotWriteOptions(
  options?: FileStoreWriteOptions,
  durabilityFirst = true,
): FileStoreWriteOptions | undefined {
  if (options == null) return undefined;
  return durabilityFirst ? {
    maxBytes: options.maxBytes,
    durable: options.durable,
    dirMode: options.dirMode,
    mode: options.mode,
  } : {
    maxBytes: options.maxBytes,
    dirMode: options.dirMode,
    mode: options.mode,
    durable: options.durable,
  };
}

export type FileStoreReadOptions = RootReadOptions & { encoding?: BufferEncoding };

export type FileStore = {
  readonly rootDir: string;
  path(relativePath: string): string;
  root(): Promise<Root>;
  write(
    relativePath: string,
    data: string | Uint8Array,
    options?: FileStoreWriteOptions,
  ): Promise<string>;
  writeStream(relativePath: string, stream: Readable, options?: FileStoreWriteOptions): Promise<string>;
  copyIn(relativePath: string, sourcePath: string, options?: FileStoreWriteOptions): Promise<string>;
  open(relativePath: string, options?: RootReadOptions): Promise<OpenResult>;
  read(relativePath: string, options?: RootReadOptions): Promise<ReadResult>;
  readBytes(relativePath: string, options?: RootReadOptions): Promise<Buffer>;
  readText(relativePath: string, options?: FileStoreReadOptions): Promise<string>;
  readTextIfExists(relativePath: string, options?: FileStoreReadOptions): Promise<string | null>;
  readJson<T = unknown>(relativePath: string, options?: FileStoreReadOptions): Promise<T>;
  readJsonIfExists<T = unknown>(
    relativePath: string,
    options?: FileStoreReadOptions,
  ): Promise<T | null>;
  remove(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  writeText(
    relativePath: string,
    data: string | Uint8Array,
    options?: FileStoreWriteOptions,
  ): Promise<string>;
  writeJson(
    relativePath: string,
    data: unknown,
    options?: FileStoreWriteOptions & { trailingNewline?: boolean },
  ): Promise<string>;
  json<T = unknown>(relativePath: string, options?: JsonFileStoreOptions): JsonStore<T>;
  pruneExpired(options: FileStorePruneOptions): Promise<void>;
};

export type FileStoreSync = {
  readonly rootDir: string;
  path(relativePath: string): string;
  readTextIfExists(relativePath: string, options?: { maxBytes?: number }): string | null;
  readJsonIfExists<T = unknown>(relativePath: string, options?: { maxBytes?: number }): T | null;
  write(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): string;
  writeText(relativePath: string, data: string | Uint8Array, options?: FileStoreWriteOptions): string;
  writeJson(
    relativePath: string,
    data: unknown,
    options?: FileStoreWriteOptions & { trailingNewline?: boolean },
  ): string;
};

function isNotFound(error: unknown): boolean {
  return error instanceof FsSafeError ? error.code === "not-found" : isNotFoundPathError(error);
}

function handleSyncStoreReadOpenFailure(opened: RootFileOpenFailure): null {
  return matchRootFileOpenFailure<null>(opened, {
    path: (failure) => {
      if (isNotFound(failure.error)) {
        return null;
      }
      throw new FsSafeError("path-mismatch", "store target changed during read", {
        cause: failure.error instanceof Error ? failure.error : undefined,
      });
    },
    validation: (failure) => {
      if (failure.error instanceof FsSafeError) {
        throw failure.error;
      }
      // Validation failures mean the path existed but violated store policy
      // (directory, hardlink, symlink race). Do not report them as missing.
      throw new FsSafeError("path-mismatch", "store target failed read validation", {
        cause: failure.error instanceof Error ? failure.error : undefined,
      });
    },
    io: (failure) => throwFsSafeReadError(failure.error, "store"),
    fallback: (failure) => {
      throw new FsSafeError("path-mismatch", "store target changed during read", {
        cause: failure.error instanceof Error ? failure.error : undefined,
      });
    },
  });
}

async function copyIntoRoot(params: {
  rootDir: string;
  relativePath: string;
  sourcePath: string;
  durable: boolean;
  dirMode: number;
  maxBytes?: number;
  mode: number;
  tempPrefix?: string;
}): Promise<string> {
  const relativePath = assertRelativePath(params.relativePath);
  const destination = resolveStorePath(params.rootDir, relativePath);
  assertNoWindowsPathAlias(params.sourcePath, "filesystem", "source path uses a Windows filesystem namespace alias");
  const sourceStat = syncFs.lstatSync(params.sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new FsSafeError("not-file", "source path is not a file");
  }
  assertFileStoreMaxBytes(sourceStat.size, params.maxBytes);
  const scopedRoot = await openWritableStoreRoot({
    rootDir: params.rootDir,
    dirMode: params.dirMode,
    maxBytes: params.maxBytes,
  });
  await ensureParentInRoot(scopedRoot, relativePath, params.dirMode);
  await scopedRoot.copyIn(relativePath, params.sourcePath, {
    durable: params.durable,
    maxBytes: params.maxBytes,
    mkdir: false,
    mode: params.mode,
  });
  return destination;
}

export function fileStore(options: FileStoreOptions): FileStore {
  const rootDirInput = options.rootDir;
  assertNoWindowsPathAlias(rootDirInput, "filesystem", "store root uses a Windows filesystem namespace alias");
  const rootDir = resolvePathPreservingWindowsRoot(rootDirInput);
  assertNoWindowsPathAlias(rootDir, "filesystem", "store root uses a Windows filesystem namespace alias");
  const privateMode = options.private ?? false;
  const dirMode = options.dirMode ?? 0o700;
  const mode = options.mode ?? 0o600;
  const durable = options.durable ?? true;
  const maxBytes = normalizeMaxBytes(options.maxBytes);

  async function openRoot(): Promise<Root> {
    return await root(rootDir, { hardlinks: "reject", maxBytes });
  }

  async function write(
    relativePath: string,
    data: string | Uint8Array,
    writeOptions?: FileStoreWriteOptions,
  ): Promise<string> {
    const safeRelativePath = assertRelativePath(relativePath);
    const destination = resolveStorePath(rootDir, safeRelativePath);
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const writeMaxBytes = normalizeMaxBytes(writeOptions?.maxBytes, { defaultValue: maxBytes });
    assertFileStoreMaxBytes(content.byteLength, writeMaxBytes);
    if (privateMode) {
      await writeSecretFileAtomic({
        rootDir,
        filePath: destination,
        content,
        durable: writeOptions?.durable ?? durable,
        dirMode: writeOptions?.dirMode ?? dirMode,
        mode: writeOptions?.mode ?? mode,
      });
      return destination;
    }
    const writeDirMode = writeOptions?.dirMode ?? dirMode;
    const writeMode = writeOptions?.mode ?? mode;
    const writeDurable = writeOptions?.durable ?? durable;
    const scopedRoot = await openWritableStoreRoot({
      rootDir,
      dirMode: writeDirMode,
      maxBytes: writeMaxBytes,
    });
    await ensureParentInRoot(scopedRoot, safeRelativePath, writeDirMode);
    await scopedRoot.write(safeRelativePath, content, {
      mkdir: false,
      mode: writeMode,
      durable: writeDurable,
    });
    return destination;
  }

  return {
    rootDir,
    path: (relativePath) => resolveStorePath(rootDir, relativePath),
    root: openRoot,
    write,
    writeStream: async (relativePath, stream, writeOptions) => {
      const safeRelativePath = assertRelativePath(relativePath);
      const destination = resolveStorePath(rootDir, safeRelativePath);
      const configuredLimit = normalizeMaxBytes(writeOptions?.maxBytes, { defaultValue: maxBytes });
      const limit = configuredLimit ?? (privateMode ? DEFAULT_ROOT_MAX_BYTES : undefined);
      if (privateMode) {
        const writeDurable = writeOptions?.durable ?? durable;
        const writeDirMode = writeOptions?.dirMode ?? dirMode;
        const writeMode = writeOptions?.mode ?? mode;
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of stream) {
          const buffer =
            typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
          total += buffer.byteLength;
          assertFileStoreMaxBytes(total, limit);
          chunks.push(buffer);
        }
        await writeSecretFileAtomic({
          rootDir,
          filePath: destination,
          content: Buffer.concat(chunks),
          durable: writeDurable,
          dirMode: writeDirMode,
          mode: writeMode,
        });
        return destination;
      }
      const writeMode = writeOptions?.mode ?? mode;
      const writeDurable = writeOptions?.durable ?? durable;
      const writeDirMode = writeOptions?.dirMode ?? dirMode;
      const staged = await writeStreamToTempSource({
        stream,
        maxBytes: limit,
        mode: writeMode,
      });
      try {
        await copyIntoRoot({
          rootDir,
          relativePath: safeRelativePath,
          sourcePath: staged.path,
          durable: writeDurable,
          maxBytes: limit,
          mode: writeMode,
          tempPrefix: writeOptions?.tempPrefix,
          dirMode: writeDirMode,
        });
      } finally {
        await staged.cleanup();
      }
      return destination;
    },
    copyIn: async (relativePath, sourcePath, writeOptions) => {
      const configuredLimit = normalizeMaxBytes(writeOptions?.maxBytes, { defaultValue: maxBytes });
      if (privateMode) {
        const policy = writeOptions == null
          ? undefined
          : {
              maxBytes: configuredLimit,
              durable: writeOptions?.durable,
              dirMode: writeOptions?.dirMode,
              mode: writeOptions?.mode,
            };
        const buffer = await readFileStoreCopySource({
          sourcePath,
          maxBytes: configuredLimit ?? DEFAULT_ROOT_MAX_BYTES,
        });
        return await write(relativePath, buffer, policy);
      }
      return await copyIntoRoot({
        rootDir,
        relativePath,
        sourcePath,
        durable: writeOptions?.durable ?? durable,
        dirMode: writeOptions?.dirMode ?? dirMode,
        maxBytes: configuredLimit,
        mode: writeOptions?.mode ?? mode,
        tempPrefix: writeOptions?.tempPrefix,
      });
    },
    open: async (relativePath, readOptions) =>
      await (await openRoot()).open(assertRelativePath(relativePath), readOptions),
    read: async (relativePath, readOptions) =>
      await (await openRoot()).read(assertRelativePath(relativePath), readOptions),
    readBytes: async (relativePath, readOptions) =>
      await (await openRoot()).readBytes(assertRelativePath(relativePath), readOptions),
    readText: async (relativePath, readOptions) => {
      const { encoding = "utf8", ...options } = readOptions ?? {};
      return (await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer
        .toString(encoding);
    },
    readTextIfExists: async (relativePath, readOptions) => {
      try {
        return await (await openRoot()).readText(assertRelativePath(relativePath), readOptions);
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throwFsSafeReadError(error, "store");
      }
    },
    readJson: async <T = unknown>(relativePath: string, readOptions?: FileStoreReadOptions) => {
      const { encoding = "utf8", ...options } = readOptions ?? {};
      return JSON.parse(
        (await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer
          .toString(encoding),
      ) as T;
    },
    readJsonIfExists: async <T = unknown>(
      relativePath: string,
      readOptions?: FileStoreReadOptions,
    ) => {
      try {
        return await (await openRoot()).readJson<T>(assertRelativePath(relativePath), readOptions);
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throwFsSafeReadError(error, "store");
      }
    },
    remove: async (relativePath) => {
      await (await openRoot()).remove(assertRelativePath(relativePath));
    },
    exists: async (relativePath) => await (await openRoot()).exists(assertRelativePath(relativePath)),
    writeText: async (relativePath, data, writeOptions) => await write(relativePath, data, writeOptions),
    writeJson: async (relativePath, data, writeOptions) => {
      const trailingNewline = writeOptions?.trailingNewline;
      const policy = snapshotWriteOptions(writeOptions, privateMode);
      const json = stringifyJsonDocument(data, null, 2);
      return await write(
        relativePath,
        trailingNewline === false ? json : `${json}\n`,
        policy,
      );
    },
    json: <T = unknown>(relativePath: string, jsonOptions?: JsonFileStoreOptions) => {
      const filePath = resolveStorePath(rootDir, relativePath);
      return createJsonStore<T>(
        {
          filePath,
          ...(privateMode ? {
            prepareLock: () => openPrivateStoreLockRoot({ rootDir, filePath, mode, dirMode }),
          } : {}),
          readIfExists: async () => {
            try {
              return await (await openRoot()).readJson<T>(assertRelativePath(relativePath));
            } catch (error) {
              if (isNotFound(error)) {
                return undefined;
              }
              throw error;
            }
          },
          readRequired: async () =>
            await (await openRoot()).readJson<T>(assertRelativePath(relativePath)),
          write: async (value, options) => {
            const json = stringifyJsonDocument(value, null, 2);
            await write(
              relativePath,
              options?.trailingNewline === false ? json : `${json}\n`,
              { durable: options?.durable },
            );
          },
        },
        jsonOptions,
      );
    },
    pruneExpired: async (pruneOptions) => {
      await pruneExpiredStoreEntries({ rootDir, dirMode, options: pruneOptions });
    },
  };
}

export function fileStoreSync(options: FileStoreOptions): FileStoreSync {
  const rootDirInput = options.rootDir;
  assertNoWindowsPathAlias(rootDirInput, "filesystem", "store root uses a Windows filesystem namespace alias");
  const rootDir = resolvePathPreservingWindowsRoot(rootDirInput);
  assertNoWindowsPathAlias(rootDir, "filesystem", "store root uses a Windows filesystem namespace alias");
  const privateMode = options.private ?? false;
  const dirMode = options.dirMode ?? 0o700;
  const mode = options.mode ?? 0o600;
  const durable = options.durable ?? true;
  const maxBytes = normalizeMaxBytes(options.maxBytes);

  function write(
    relativePath: string,
    data: string | Uint8Array,
    writeOptions?: FileStoreWriteOptions,
  ): string {
    const destination = resolveStorePath(rootDir, relativePath);
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const writeMaxBytes = normalizeMaxBytes(writeOptions?.maxBytes, { defaultValue: maxBytes });
    assertFileStoreMaxBytes(content.byteLength, writeMaxBytes);
    return writeFileSyncAtomic({
      rootDir,
      filePath: destination,
      content,
      privateMode,
      durable: writeOptions?.durable ?? durable,
      dirMode: writeOptions?.dirMode ?? dirMode,
      mode: writeOptions?.mode ?? mode,
    });
  }

  let readTextIfExists: FileStoreSync["readTextIfExists"];
  return {
    rootDir,
    path: (relativePath) => resolveStorePath(rootDir, relativePath),
    readTextIfExists: readTextIfExists = (relativePath, readOptions) => {
      const limit = normalizeMaxBytes(readOptions?.maxBytes, { defaultValue: maxBytes });
      const targetPath = resolveStorePath(rootDir, relativePath);
      const opened = openRootFileSync({
        absolutePath: targetPath,
        rootPath: rootDir,
        boundaryLabel: "store root",
        rejectHardlinks: true,
      });
      if (!opened.ok) {
        return handleSyncStoreReadOpenFailure(opened);
      }
      try {
        assertFileStoreMaxBytes(opened.stat.size, limit);
        try {
          return limit === undefined
            ? syncFs.readFileSync(opened.fd, "utf8")
            : readFileDescriptorBoundedSync(opened.fd, limit).toString("utf8");
        } catch (error) {
          throwFsSafeReadError(error, "store");
        }
      } finally {
        syncFs.closeSync(opened.fd);
      }
    },
    readJsonIfExists: <T = unknown>(relativePath: string, readOptions?: { maxBytes?: number }) => {
      const raw = readTextIfExists(relativePath, readOptions);
      return raw === null ? null : (JSON.parse(raw) as T);
    },
    write,
    writeText: (relativePath, data, writeOptions) => write(relativePath, data, writeOptions),
    writeJson: (relativePath, data, writeOptions) => {
      const trailingNewline = writeOptions?.trailingNewline;
      const policy = snapshotWriteOptions(writeOptions);
      const json = stringifyJsonDocument(data, null, 2);
      return write(
        relativePath,
        trailingNewline === false ? json : `${json}\n`,
        policy,
      );
    },
  };
}
