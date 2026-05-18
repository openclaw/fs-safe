import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import { readRegularFile, readRegularFileSync } from "./regular-file.js";
import { openRootFileSync, type RootFileOpenFailure } from "./root-file.js";
import { writeTextAtomic, type WriteTextAtomicOptions } from "./text-atomic.js";

const READ_RETRY_MAX_ATTEMPTS = 3;
const READ_RETRY_BASE_DELAY_MS = 50;

function isReadRaceError(err: unknown): boolean {
  return err instanceof FsSafeError && err.code === "path-mismatch";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRegularFileWithRetry(filePath: string): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < READ_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return (await readRegularFile({ filePath })).buffer;
    } catch (err) {
      lastErr = err;
      if (!isReadRaceError(err) || attempt === READ_RETRY_MAX_ATTEMPTS - 1) {
        throw err;
      }
      await sleep(READ_RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

const JSON_FILE_MODE = 0o600;
const JSON_DIR_MODE = 0o700;
const SUPPORTS_SYNC_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsSync.constants;

function getErrorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

function trySetSecureMode(pathname: string) {
  let fd: number | undefined;
  try {
    fd = fsSync.openSync(
      pathname,
      fsSync.constants.O_RDONLY |
        (SUPPORTS_SYNC_NOFOLLOW ? fsSync.constants.O_NOFOLLOW : 0),
    );
    fsSync.fchmodSync(fd, JSON_FILE_MODE);
  } catch {
    // best-effort on platforms without chmod support
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

function renameJsonFileWithFallback(tmpPath: string, pathname: string) {
  try {
    fsSync.renameSync(tmpPath, pathname);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EEXIST") {
      const existing = (() => {
        try {
          return fsSync.lstatSync(pathname);
        } catch (lstatError) {
          if ((lstatError as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw lstatError;
        }
      })();
      if (existing?.isSymbolicLink()) {
        fsSync.rmSync(pathname, { force: true });
        fsSync.renameSync(tmpPath, pathname);
        return;
      }
      fsSync.rmSync(pathname, { force: true });
      fsSync.renameSync(tmpPath, pathname);
      return;
    }
    throw error;
  }
}

function writeTempJsonFile(pathname: string, payload: string) {
  const fd = fsSync.openSync(pathname, "wx", JSON_FILE_MODE);
  try {
    fsSync.writeFileSync(fd, payload, "utf8");
    fsSync.fsyncSync(fd);
  } finally {
    fsSync.closeSync(fd);
  }
}

export function tryReadJsonSync<T = unknown>(pathname: string): T | null {
  try {
    const raw = readRegularFileSync({ filePath: pathname }).buffer.toString("utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJsonSync(pathname: string, data: unknown) {
  const targetPath = pathname;
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  const payload = `${stringifyJsonDocument(data, null, 2)}\n`;

  fsSync.mkdirSync(path.dirname(targetPath), { recursive: true, mode: JSON_DIR_MODE });
  try {
    writeTempJsonFile(tmpPath, payload);
    trySetSecureMode(tmpPath);
    renameJsonFileWithFallback(tmpPath, targetPath);
    trySetSecureMode(targetPath);
    trySyncDirectory(targetPath);
  } finally {
    try {
      fsSync.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup when rename does not happen
    }
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
  const absolutePath = path.resolve(options.rootDir, options.relativePath);
  const opened = openRootFileSync({
    absolutePath,
    rootPath: options.rootDir,
    ...(options.rootRealPath !== undefined ? { rootRealPath: options.rootRealPath } : {}),
    boundaryLabel: options.boundaryLabel,
    rejectHardlinks: options.rejectHardlinks,
    maxBytes: options.maxBytes,
    allowedType: "file",
  });
  if (!opened.ok) {
    return { ok: false, reason: "open", failure: opened };
  }

  try {
    const parsed = options.parse(fsSync.readFileSync(opened.fd, "utf8"));
    if (options.validate && !options.validate(parsed)) {
      return {
        ok: false,
        reason: "invalid",
        error: resolveInvalidMessage(options.invalidMessage, options.relativePath),
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
      error: `failed to parse ${options.relativePath}: ${String(error)}`,
    };
  } finally {
    fsSync.closeSync(opened.fd);
  }
}

export function readRootJsonSync<T = unknown>(
  options: ReadRootJsonSyncOptions,
): RootStructuredFileReadResult<T> {
  return readRootStructuredFileSync<T>({
    ...options,
    parse: (raw) => JSON.parse(raw),
  });
}

export function readRootJsonObjectSync(
  options: ReadRootJsonSyncOptions,
): RootStructuredFileReadResult<Record<string, unknown>> {
  return readRootStructuredFileSync<Record<string, unknown>>({
    ...options,
    parse: (raw) => JSON.parse(raw),
    validate: isRecord,
    invalidMessage: (relativePath) => `${relativePath} must contain a JSON object`,
  });
}

export async function tryReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = (await readRegularFileWithRetry(filePath)).toString("utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  let raw: string;
  try {
    raw = (await readRegularFileWithRetry(filePath)).toString("utf8");
  } catch (err) {
    throw new JsonFileReadError(filePath, "read", err);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new JsonFileReadError(filePath, "parse", err);
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = (await readRegularFileWithRetry(filePath)).toString("utf8");
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

export function readJsonSync<T = unknown>(filePath: string): T {
  let raw: string;
  try {
    raw = readRegularFileSync({ filePath }).buffer.toString("utf8");
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
  const text = stringifyJsonDocument(value, null, 2);
  await writeTextAtomic(filePath, text, {
    mode: options?.mode,
    dirMode: options?.dirMode,
    trailingNewline: options?.trailingNewline,
    durable: options?.durable,
  });
}
