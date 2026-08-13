import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  fileStore,
  fileStoreSync,
  type FileStore,
  type FileStoreSync,
} from "./file-store.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { isNotFoundPathError } from "./path.js";
import { throwFsSafeReadError } from "./read-error.js";
import {
  matchRootFileOpenFailure,
  openRootFileSync,
  type RootFileOpenFailure,
} from "./root-file.js";
import {
  registerTempPathForExit,
  type TempPathIdentityReceipt,
} from "./temp-cleanup.js";

export type TempWorkspaceCleanupResult = "removed" | "missing" | "identity-mismatch";

export type TempWorkspaceOptions = {
  rootDir: string;
  prefix: string;
  dirMode?: number;
  mode?: number;
};

export type TempWorkspace = {
  dir: string;
  identity: TempPathIdentityReceipt;
  store: FileStore;
  path(fileName: string): string;
  write(fileName: string, data: string | Uint8Array): Promise<string>;
  writeText(fileName: string, data: string): Promise<string>;
  writeJson(
    fileName: string,
    data: unknown,
    options?: { trailingNewline?: boolean },
  ): Promise<string>;
  copyIn(fileName: string, sourcePath: string): Promise<string>;
  read(fileName: string): Promise<Buffer>;
  cleanup(): Promise<TempWorkspaceCleanupResult>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type TempWorkspaceSync = {
  dir: string;
  identity: TempPathIdentityReceipt;
  store: FileStoreSync;
  path(fileName: string): string;
  write(fileName: string, data: string | Uint8Array): string;
  writeText(fileName: string, data: string): string;
  writeJson(fileName: string, data: unknown, options?: { trailingNewline?: boolean }): string;
  read(fileName: string): Buffer;
  cleanup(): TempWorkspaceCleanupResult;
  [Symbol.dispose](): void;
};

function sanitizeTempPrefix(prefix: string): string {
  const sanitized = prefix.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "fs-safe-";
  }
  return sanitized.endsWith("-") ? sanitized : `${sanitized}-`;
}

function resolveWorkspaceLeaf(dir: string, fileName: string): string {
  return path.join(dir, assertWorkspaceFileName(fileName));
}

function assertWorkspaceFileName(fileName: string): string {
  const value = fileName.trim();
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\") ||
    path.basename(value) !== value
  ) {
    throw new Error(`Invalid temp workspace file name: ${JSON.stringify(fileName)}`);
  }
  return value;
}

function throwTempWorkspaceOpenFailure(failure: RootFileOpenFailure): never {
  return matchRootFileOpenFailure<never>(failure, {
    path: ({ error }) => {
      if (isNotFoundPathError(error)) {
        throw new FsSafeError("not-found", "temp workspace file not found", { cause: error });
      }
      throw new FsSafeError("path-mismatch", "temp workspace target changed during read", {
        cause: error,
      });
    },
    validation: ({ error }) => {
      if (error instanceof FsSafeError) {
        throw error;
      }
      throw new FsSafeError("path-mismatch", "temp workspace target failed read validation", {
        cause: error,
      });
    },
    io: ({ error }) => throwFsSafeReadError(error, "temp workspace"),
    fallback: ({ error }) => {
      throw new FsSafeError("path-mismatch", "temp workspace target changed during read", {
        cause: error,
      });
    },
  });
}

async function ensurePrivateDirectory(dir: string, mode: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode });
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) {
    throw new Error(`Temp root must be a directory: ${dir}`);
  }
  await fs.chmod(dir, mode).catch(() => undefined);
}

function ensurePrivateDirectorySync(dir: string, mode: number): void {
  fsSync.mkdirSync(dir, { recursive: true, mode });
  const stat = fsSync.statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`Temp root must be a directory: ${dir}`);
  }
  try {
    fsSync.chmodSync(dir, mode);
  } catch {
    // Best-effort on platforms that do not enforce POSIX modes.
  }
}

async function cleanupWorkspace(
  dir: string,
  identity: TempPathIdentityReceipt,
): Promise<TempWorkspaceCleanupResult> {
  let current;
  try {
    current = await fs.lstat(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "identity-mismatch";
  }
  if (!sameFileIdentityForCleanup(current, identity)) {
    return "identity-mismatch";
  }
  await fs.rm(dir, { recursive: true, force: true });
  return "removed";
}

function cleanupWorkspaceSync(
  dir: string,
  identity: TempPathIdentityReceipt,
): TempWorkspaceCleanupResult {
  let current;
  try {
    current = fsSync.lstatSync(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "identity-mismatch";
  }
  if (!sameFileIdentityForCleanup(current, identity)) {
    return "identity-mismatch";
  }
  fsSync.rmSync(dir, { recursive: true, force: true });
  return "removed";
}

async function createTempWorkspace(
  options: TempWorkspaceOptions,
): Promise<TempWorkspace> {
  const dirMode = options.dirMode ?? 0o700;
  const mode = options.mode ?? 0o600;
  const requestedRoot = path.resolve(options.rootDir);
  const root = await fs.realpath(requestedRoot).catch(() => requestedRoot);
  await ensurePrivateDirectory(root, dirMode);
  const dir = await fs.mkdtemp(path.join(root, sanitizeTempPrefix(options.prefix)));
  await fs.chmod(dir, dirMode).catch(() => undefined);
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Temp workspace must be a directory: ${dir}`);
  }
  const identity = { dev: stat.dev, ino: stat.ino };
  const unregisterTempDir = registerTempPathForExit(dir, { recursive: true, identity });
  const store = fileStore({ rootDir: dir, private: true, dirMode, mode });

  return {
    dir,
    identity,
    store,
    path: (fileName) => resolveWorkspaceLeaf(dir, fileName),
    write: async (fileName, data) =>
      await store.write(assertWorkspaceFileName(fileName), data, { mode }),
    writeText: async (fileName, data) =>
      await store.writeText(assertWorkspaceFileName(fileName), data, { mode }),
    writeJson: async (fileName, data, writeOptions) =>
      await store.writeJson(assertWorkspaceFileName(fileName), data, {
        mode,
        trailingNewline: writeOptions?.trailingNewline,
      }),
    copyIn: async (fileName, sourcePath) =>
      await store.copyIn(assertWorkspaceFileName(fileName), sourcePath, { mode }),
    read: async (fileName) => {
      try {
        return await store.readBytes(assertWorkspaceFileName(fileName));
      } catch (error) {
        throwFsSafeReadError(error, "temp workspace");
      }
    },
    cleanup: async () => {
      try {
        return await cleanupWorkspace(dir, identity);
      } finally {
        unregisterTempDir();
      }
    },
    [Symbol.asyncDispose]: async () => {
      try {
        await cleanupWorkspace(dir, identity);
      } finally {
        unregisterTempDir();
      }
    },
  };
}

export async function tempWorkspace(
  options: TempWorkspaceOptions,
): Promise<TempWorkspace> {
  return await createTempWorkspace(options);
}

export async function withTempWorkspace<T>(
  options: TempWorkspaceOptions,
  run: (workspace: TempWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await createTempWorkspace({
    ...options,
    prefix: `${sanitizeTempPrefix(options.prefix)}${randomUUID()}-`,
  });
  try {
    return await run(workspace);
  } finally {
    await workspace.cleanup();
  }
}

export function tempWorkspaceSync(
  options: TempWorkspaceOptions,
): TempWorkspaceSync {
  const dirMode = options.dirMode ?? 0o700;
  const mode = options.mode ?? 0o600;
  const requestedRoot = path.resolve(options.rootDir);
  let root = requestedRoot;
  try {
    root = fsSync.realpathSync.native(requestedRoot);
  } catch {
    root = requestedRoot;
  }
  ensurePrivateDirectorySync(root, dirMode);
  const dir = fsSync.mkdtempSync(path.join(root, sanitizeTempPrefix(options.prefix)));
  try {
    fsSync.chmodSync(dir, dirMode);
  } catch {
    // Best-effort on platforms that do not enforce POSIX modes.
  }
  const stat = fsSync.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Temp workspace must be a directory: ${dir}`);
  }
  const identity = { dev: stat.dev, ino: stat.ino };
  const unregisterTempDir = registerTempPathForExit(dir, { recursive: true, identity });
  const store = fileStoreSync({ rootDir: dir, private: true, dirMode, mode });

  return {
    dir,
    identity,
    store,
    path: (fileName) => resolveWorkspaceLeaf(dir, fileName),
    write: (fileName, data) =>
      store.write(assertWorkspaceFileName(fileName), data, { mode }),
    writeText: (fileName, data) =>
      store.writeText(assertWorkspaceFileName(fileName), data, { mode }),
    writeJson: (fileName, data, writeOptions) =>
      store.writeJson(assertWorkspaceFileName(fileName), data, {
        mode,
        trailingNewline: writeOptions?.trailingNewline,
      }),
    read: (fileName) => {
      const opened = openRootFileSync({
        absolutePath: store.path(assertWorkspaceFileName(fileName)),
        rootPath: dir,
        boundaryLabel: "temp workspace",
        rejectHardlinks: true,
      });
      if (!opened.ok) {
        throwTempWorkspaceOpenFailure(opened);
      }
      try {
        try {
          return fsSync.readFileSync(opened.fd);
        } catch (error) {
          throwFsSafeReadError(error, "temp workspace");
        }
      } finally {
        fsSync.closeSync(opened.fd);
      }
    },
    cleanup: () => {
      try {
        return cleanupWorkspaceSync(dir, identity);
      } finally {
        unregisterTempDir();
      }
    },
    [Symbol.dispose]: () => {
      try {
        cleanupWorkspaceSync(dir, identity);
      } finally {
        unregisterTempDir();
      }
    },
  };
}

export function withTempWorkspaceSync<T>(
  options: TempWorkspaceOptions,
  run: (workspace: TempWorkspaceSync) => T,
): T {
  const workspace = tempWorkspaceSync({
    ...options,
    prefix: `${sanitizeTempPrefix(options.prefix)}${randomUUID()}-`,
  });
  try {
    return run(workspace);
  } finally {
    workspace.cleanup();
  }
}
