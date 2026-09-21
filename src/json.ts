import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { readFileDescriptorBoundedSync } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import { readRegularFile, readRegularFileSync, statRegularFile } from "./regular-file.js";
import { openRootFileSync, type RootFileOpenFailure } from "./root-file.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { writeTempFileSync } from "./replace-file-descriptor.js";
import { SyncAtomicTempOwner, type AtomicTempFailure } from "./replace-file-temp-owner.js";
import { admitStandalonePublicationPath } from "./standalone-publication-path.js";
import { writeTextAtomic, type WriteTextAtomicOptions } from "./text-atomic.js";
import { sleep } from "./timing.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

const READ_RETRY_MAX_ATTEMPTS = 5;
const READ_RETRY_BASE_DELAY_MS = 50;

function isRetryableReadError(err: unknown): boolean {
  if (err instanceof FsSafeError && err.code === "path-mismatch") {
    return true;
  }
  const code = getErrorCode(err);
  return code === "ENOENT" || code === "EPERM";
}

async function readRegularFileWithRetry(
  filePath: string,
  maxBytes?: number,
): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < READ_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return (await readRegularFile({ filePath, maxBytes })).buffer;
    } catch (err) {
      lastErr = err;
      if (!isRetryableReadError(err) || attempt === READ_RETRY_MAX_ATTEMPTS - 1) {
        throw err;
      }
      await sleep(READ_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

async function readRegularFileIfExistsWithRetry(
  filePath: string,
  options: ReadJsonOptions = {},
): Promise<Buffer | null> {
  const initial = await statRegularFile(filePath);
  if (initial.missing) {
    return null;
  }
  return await readRegularFileWithRetry(filePath, options.maxBytes);
}

const JSON_FILE_MODE = 0o600;
const JSON_DIR_MODE = 0o700;
function getErrorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

function trySetSecureMode(fd: number): void {
  try {
    fsSync.fchmodSync(fd, JSON_FILE_MODE);
  } catch {
    // Best-effort mode application stays on the retained staging descriptor.
  }
}

function trySyncDirectory(pathname: string) {
  let fd: number | undefined;
  try {
    fd = fsSync.openSync(path.dirname(pathname), "r");
    fsSync.fsyncSync(fd);
  } catch {
    // best-effort; some platforms/filesystems do not support syncing directories.
  } finally {
    if (fd !== undefined) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function renameJsonFileWithFallback(owner: SyncAtomicTempOwner, pathname: string) {
  owner.assertCurrent(fsSync);
  try {
    fsSync.renameSync(owner.pathname, pathname);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
    if (code === "EPERM" || code === "EEXIST") {
      owner.assertCurrent(fsSync);
      fsSync.rmSync(pathname, { force: true });
      owner.assertCurrent(fsSync);
      fsSync.renameSync(owner.pathname, pathname);
      return;
    }
    throw error;
  }
}

export type ReadJsonOptions = {
  maxBytes?: number;
};

export function tryReadJsonSync<T = unknown>(
  pathname: string,
  options: ReadJsonOptions = {},
): T | null {
  try {
    const raw = readRegularFileSync({
      filePath: pathname,
      maxBytes: options.maxBytes,
    }).buffer.toString("utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJsonSync(pathname: string, data: unknown) {
  const filePath = admitStandalonePublicationPath(pathname);
  // Keep literal parent segments so staging follows the same symlinks as the target.
  const tmpPath = path.format({ ...path.parse(filePath), base: `.fs-safe-${randomUUID()}.tmp` });
  const payload = `${stringifyJsonDocument(data, null, 2)}\n`;

  fsSync.mkdirSync(recursiveMkdirPath(path.dirname(filePath)), { recursive: true, mode: JSON_DIR_MODE });
  const owner = new SyncAtomicTempOwner(tmpPath);
  let originalFailure: AtomicTempFailure | undefined;
  try {
    owner.start();
    const temp = writeTempFileSync({
      fsModule: fsSync, tempPath: tmpPath, content: payload, mode: JSON_FILE_MODE,
      sync: false, onIdentity: owner.onIdentity,
    });
    owner.adopt(temp);
    owner.assertCurrent(fsSync);
    trySetSecureMode(temp.fd);
    fsSync.fsyncSync(temp.fd);
    renameJsonFileWithFallback(owner, filePath);
    owner.markRenamed();
    owner.assertPublished(fsSync, filePath);
    trySetSecureMode(temp.fd);
    trySyncDirectory(filePath);
    owner.assertPublished(fsSync, filePath);
  } catch (error) {
    originalFailure = { error };
    throw error;
  } finally {
    owner.finish({ fsModule: fsSync, originalFailure, throwOnCleanupError: false });
  }
}

export class JsonFileReadError extends Error {
  readonly filePath: string;
  readonly reason: "read" | "parse";

  constructor(filePath: string, reason: "read" | "parse", cause: unknown) {
    super(`Failed to ${reason} JSON file: ${filePath}`, { cause });
    this.name = "JsonFileReadError";
    this.filePath = filePath;
    this.reason = reason;
  }
}

export type RootStructuredFileReadResult<T> =
  | { ok: true; value: T; stat: fsSync.Stats; path: string; rootRealPath: string }
  | { ok: false; reason: "open"; failure: RootFileOpenFailure }
  | { ok: false; reason: "invalid" | "parse"; error: string };

export type ReadRootStructuredFileSyncOptions<T> = {
  rootDir: string;
  rootRealPath?: string;
  relativePath: string;
  boundaryLabel: string;
  rejectHardlinks?: boolean;
  maxBytes?: number;
  parse: (raw: string) => unknown;
  validate?: (value: unknown) => value is T;
  invalidMessage?: string | ((relativePath: string) => string);
};

export type ReadRootJsonSyncOptions = Omit<
  ReadRootStructuredFileSyncOptions<unknown>,
  "parse" | "validate" | "invalidMessage"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveInvalidMessage(
  invalidMessage: ReadRootStructuredFileSyncOptions<unknown>["invalidMessage"],
  relativePath: string,
): string {
  if (typeof invalidMessage === "function") {
    return invalidMessage(relativePath);
  }
  return invalidMessage ?? `${relativePath} has an unexpected shape`;
}

export function readRootStructuredFileSync<T>(
  options: ReadRootStructuredFileSyncOptions<T>,
): RootStructuredFileReadResult<T> {
  return readRootStructuredFileSyncInternal(options, options);
}

type RootStructuredFileParser<T> = Pick<
  ReadRootStructuredFileSyncOptions<T>,
  "parse" | "validate" | "invalidMessage"
>;

function readRootStructuredFileSyncInternal<T>(
  options: ReadRootJsonSyncOptions,
  parser: RootStructuredFileParser<T>,
): RootStructuredFileReadResult<T> {
  let absolutePath: string;
  let relativePath: string;
  let rootDir: string;
  let rootRealPath: string | undefined;
  try {
    rootDir = options.rootDir;
    relativePath = options.relativePath;
    rootRealPath = options.rootRealPath;
    assertNoWindowsPathAlias(rootDir);
    assertNoWindowsPathAlias(relativePath, "relative");
    if (rootRealPath !== undefined) {
      assertNoWindowsPathAlias(rootRealPath);
    }
    absolutePath = path.resolve(rootDir, relativePath);
    assertNoWindowsPathAlias(absolutePath);
  } catch (error) {
    return {
      ok: false,
      reason: "open",
      failure: { ok: false, reason: "validation", error },
    };
  }
  const boundaryLabel = options.boundaryLabel;
  const rejectHardlinks = options.rejectHardlinks;
  const maxBytes = options.maxBytes;
  const opened = openRootFileSync({
    absolutePath,
    rootPath: rootDir,
    rootRealPath,
    boundaryLabel,
    rejectHardlinks,
    maxBytes,
    allowedType: "file",
  });
  if (!opened.ok) {
    return { ok: false, reason: "open", failure: opened };
  }

  try {
    const raw =
      maxBytes === undefined
        ? fsSync.readFileSync(opened.fd, "utf8")
        : readFileDescriptorBoundedSync(opened.fd, maxBytes).toString("utf8");
    const parse = parser.parse;
    const parsed = Reflect.apply(parse, parser, [raw]);
    const validate = parser.validate;
    if (validate && !Reflect.apply(validate, parser, [parsed])) {
      return {
        ok: false,
        reason: "invalid",
        error: resolveInvalidMessage(parser.invalidMessage, relativePath),
      };
    }
    return {
      ok: true,
      value: parsed as T,
      stat: opened.stat,
      path: opened.path,
      rootRealPath: opened.rootRealPath,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "parse",
      error: `failed to parse ${relativePath}: ${String(error)}`,
    };
  } finally {
    fsSync.closeSync(opened.fd);
  }
}

export function readRootJsonSync<T = unknown>(
  options: ReadRootJsonSyncOptions,
): RootStructuredFileReadResult<T> {
  return readRootStructuredFileSyncInternal<T>(options, {
    parse: (raw) => JSON.parse(raw),
  });
}

export function readRootJsonObjectSync(
  options: ReadRootJsonSyncOptions,
): RootStructuredFileReadResult<Record<string, unknown>> {
  return readRootStructuredFileSyncInternal<Record<string, unknown>>(options, {
    parse: (raw) => JSON.parse(raw),
    validate: isRecord,
    invalidMessage: (relativePath) => `${relativePath} must contain a JSON object`,
  });
}

export async function tryReadJson<T>(
  filePath: string,
  options: ReadJsonOptions = {},
): Promise<T | null> {
  try {
    const buffer = await readRegularFileIfExistsWithRetry(filePath, options);
    if (buffer === null) {
      return null;
    }
    const raw = buffer.toString("utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readJson<T>(filePath: string, options: ReadJsonOptions = {}): Promise<T> {
  let raw: string;
  try {
    raw = (
      await readRegularFileWithRetry(filePath, options.maxBytes)
    ).toString("utf8");
  } catch (err) {
    throw new JsonFileReadError(filePath, "read", err);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new JsonFileReadError(filePath, "parse", err);
  }
}

export async function readJsonIfExists<T>(
  filePath: string,
  options: ReadJsonOptions = {},
): Promise<T | null> {
  let raw: string;
  try {
    const buffer = await readRegularFileIfExistsWithRetry(filePath, options);
    if (buffer === null) {
      return null;
    }
    raw = buffer.toString("utf8");
  } catch (err) {
    if (getErrorCode(err) === "ENOENT") {
      return null;
    }
    throw new JsonFileReadError(filePath, "read", err);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new JsonFileReadError(filePath, "parse", err);
  }
}

export function readJsonSync<T = unknown>(
  filePath: string,
  options: ReadJsonOptions = {},
): T {
  let raw: string;
  try {
    raw = readRegularFileSync({ filePath, maxBytes: options.maxBytes }).buffer.toString("utf8");
  } catch (err) {
    throw new JsonFileReadError(filePath, "read", err);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new JsonFileReadError(filePath, "parse", err);
  }
}

export type WriteJsonOptions = Pick<
  WriteTextAtomicOptions,
  "dirMode" | "durable" | "mode" | "trailingNewline"
>;

export async function writeJson(
  filePath: string,
  value: unknown,
  options?: WriteJsonOptions,
) {
  const admittedPath = admitStandalonePublicationPath(filePath);
  const text = stringifyJsonDocument(value, null, 2);
  await writeTextAtomic(admittedPath, text, {
    mode: options?.mode,
    dirMode: options?.dirMode,
    trailingNewline: options?.trailingNewline,
    durable: options?.durable,
  });
}
