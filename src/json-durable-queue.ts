import fs, { type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "./directory-durability.js";
import { syncQueueDirectoryCreation } from "./json-durable-queue-directory.js";
import {
  queueValidationRoot,
  queueValidationRoots,
  resolveQueueFilesystemPath,
  type QueueValidationRoot,
} from "./json-durable-queue-paths.js";
import {
  getErrorCode,
  acknowledgeDurableQueueEntry,
  claimDurableQueueEntry,
  completeDeliveredQueueEntry,
  migrateDurableQueueEntry,
  moveDurableQueueEntryToFailed,
  validateDurableQueueEntryPaths,
} from "./json-durable-queue-ownership.js";
import { withJsonDurableQueueEntry } from "./json-durable-queue-read.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import { realpathSync } from "./realpath.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { replaceFileAtomicWithDirectorySync } from "./replace-file.js";
import { assertSafePathSegment } from "./safe-path-segment.js";
import { admitStandalonePublicationPath } from "./standalone-publication-path.js";
import {
  assertNoWindowsPathAlias,
  hasWindowsPathAlias,
} from "./windows-path-alias.js";

export { DEFAULT_JSON_DURABLE_QUEUE_ENTRY_MAX_BYTES } from "./json-durable-queue-read.js";

export type JsonDurableQueueEntryPaths = {
  jsonPath: string;
  deliveredPath: string;
  processingPath?: string;
};

export type JsonDurableQueueReadResult<T> = {
  entry: T;
  migrated?: boolean;
};

export type JsonDurableQueueLoadOptions<T> = {
  queueDir: string;
  tempPrefix: string;
  read?: (entry: T, filePath: string) => Promise<JsonDurableQueueReadResult<T>>;
  cleanupTmpMaxAgeMs?: number;
  maxBytes?: number;
};

function assertSafeQueueEntryId(id: string): void {
  assertSafePathSegment(id, { label: "queue entry id" });
}

export async function unlinkBestEffort(filePath: string): Promise<void> {
  if (hasWindowsPathAlias(filePath, "filesystem")) return;
  await fs.promises.unlink(filePath).catch(() => undefined);
}

export async function jsonDurableQueueEntryExists(filePath: string): Promise<boolean> {
  assertNoWindowsPathAlias(filePath);
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile();
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function unlinkStaleTmpBestEffort(
  filePath: string,
  now: number,
  maxAgeMs: number,
): Promise<void> {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && now - stat.mtimeMs >= maxAgeMs) {
      await unlinkBestEffort(filePath);
    }
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

export function resolveJsonDurableQueueEntryPaths(
  queueDir: string,
  id: string,
): JsonDurableQueueEntryPaths {
  assertSafeQueueEntryId(id);
  assertNoWindowsPathAlias(queueDir);
  return {
    jsonPath: path.join(queueDir, `${id}.json`),
    deliveredPath: path.join(queueDir, `${id}.delivered`),
    processingPath: path.join(queueDir, `${id}.processing`),
  };
}

export async function ensureJsonDurableQueueDirs(params: {
  queueDir: string;
  failedDir: string;
}): Promise<void> {
  const queueDir = params.queueDir;
  const failedDir = params.failedDir;
  assertNoWindowsPathAlias(queueDir);
  assertNoWindowsPathAlias(failedDir);
  const roots = await queueValidationRoots(queueDir, failedDir);
  await ensureJsonDurableQueueDir(queueDir, roots.queueRoot);
  await ensureJsonDurableQueueDir(failedDir, roots.failedRoot);
}

async function ensureJsonDurableQueueDir(
  dir: string,
  validationRoot?: QueueValidationRoot,
): Promise<void> {
  const root = validationRoot
    ? validationRoot
    : queueValidationRoot(dir);
  await assertNoSymlinkDirectorySegments(root, dir, true);
  await fs.promises.mkdir(recursiveMkdirPath(dir), { recursive: true, mode: 0o700 });
  await assertNoSymlinkDirectorySegments(root, dir, false);
  await chmodQueueDirectory(dir);
  await syncQueueDirectoryCreation(dir, root.path);
}

async function assertJsonDurableQueueDir(
  dir: string,
  validationRoot?: QueueValidationRoot,
): Promise<void> {
  const root = validationRoot
    ? validationRoot
    : queueValidationRoot(dir);
  await assertNoSymlinkDirectorySegments(root, dir, false);
}

async function isDarwinSystemAlias(
  dir: string,
  stat: Awaited<ReturnType<typeof fs.promises.lstat>>,
): Promise<boolean> {
  if (process.platform !== "darwin" || !stat.isSymbolicLink()) {
    return false;
  }
  const resolved = path.resolve(dir);
  if (resolved !== "/tmp" && resolved !== "/var") {
    return false;
  }
  try {
    return realpathSync.native(resolved) === `/private${resolved}`;
  } catch {
    return false;
  }
}

async function assertNoSymlinkDirectorySegments(
  validationRoot: QueueValidationRoot,
  dir: string,
  allowMissing: boolean,
): Promise<void> {
  let base = resolveQueueFilesystemPath(validationRoot.path);
  let target = resolveQueueFilesystemPath(dir);
  let current = base;
  let baseStat = fs.lstatSync(base);
  if (baseStat.isSymbolicLink() && validationRoot.allowSymlinkBase) {
    const relative = path.relative(base, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`durable queue path is not a directory: ${dir}`);
    }
    base = realpathSync.native(base);
    target = path.join(base, ...relative.split(path.sep).filter(Boolean));
    current = base;
    baseStat = fs.lstatSync(base);
  }
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new Error(`durable queue path is not a directory: ${dir}`);
  }
  const segments = path.relative(base, target).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (segment === undefined) {
      continue;
    }
    current = path.join(current, segment);
    let stat: Awaited<ReturnType<typeof fs.promises.lstat>>;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      if (stat.isSymbolicLink() && validationRoot.allowSymlinkBase) {
        if (await isDarwinSystemAlias(current, stat)) {
          current = realpathSync.native(current);
          continue;
        }
      }
      throw new Error(`durable queue path is not a directory: ${dir}`);
    }
  }
}

async function chmodQueueDirectory(dir: string): Promise<void> {
  const noFollow =
    typeof fs.constants.O_NOFOLLOW === "number" && process.platform !== "win32"
      ? fs.constants.O_NOFOLLOW
      : 0;
  const directoryFlag =
    typeof fs.constants.O_DIRECTORY === "number" && process.platform !== "win32"
      ? fs.constants.O_DIRECTORY
      : 0;
  if (noFollow || directoryFlag) {
    let handle: FileHandle | undefined;
    try {
      handle = await fs.promises.open(dir, fs.constants.O_RDONLY | noFollow | directoryFlag);
      const stat = fs.fstatSync(handle.fd);
      if (!stat.isDirectory()) {
        throw new Error(`durable queue path is not a directory: ${dir}`);
      }
      try {
        await handle.chmod(0o700);
      } catch {
        // Best-effort on platforms that do not enforce POSIX modes.
      }
      return;
    } finally {
      try {
        await handle?.close();
      } catch {
        // Best-effort cleanup after chmod/open failures.
      }
    }
  }
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`durable queue path is not a directory: ${dir}`);
  }
  try {
    await fs.promises.chmod(dir, 0o700);
  } catch {
    // Best-effort on platforms that do not enforce POSIX modes.
  }
}

export async function writeJsonDurableQueueEntry(params: {
  filePath: string;
  entry: unknown;
  tempPrefix: string;
}): Promise<void> {
  await writeQueueEntry(params);
}

async function writeQueueEntry(
  params: Parameters<typeof writeJsonDurableQueueEntry>[0],
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const filePath = admitStandalonePublicationPath(params.filePath);
  const entry = params.entry;
  const tempPrefix = params.tempPrefix;
  await replaceFileAtomicWithDirectorySync({
    filePath,
    content: stringifyJsonDocument(entry, null, 2),
    mode: 0o600,
    tempPrefix,
    syncTempFile: true,
    beforeRename,
  }, syncDirectory);
}

export async function readJsonDurableQueueEntry<T>(
  filePath: string,
  options: { maxBytes?: number } = {},
): Promise<T> {
  return await withJsonDurableQueueEntry<T, T>(filePath, options, async (entry) => entry);
}

async function migrateClaimedQueueEntry(params: {
  paths: JsonDurableQueueEntryPaths;
  identity: BigIntStats;
  releaseReadPin: () => Promise<void>;
  entry: unknown;
  tempPrefix: string;
}): Promise<void> {
  await migrateDurableQueueEntry(
    params.paths, params.identity, params.releaseReadPin, async (filePath, beforePublish) => {
      await writeQueueEntry({ filePath, entry: params.entry, tempPrefix: params.tempPrefix }, beforePublish);
    },
  );
}

export async function ackJsonDurableQueueEntry(paths: JsonDurableQueueEntryPaths): Promise<void> {
  await acknowledgeDurableQueueEntry(paths);
}

export async function loadJsonDurableQueueEntry<T>(params: {
  paths: JsonDurableQueueEntryPaths;
  tempPrefix: string;
  read?: (entry: T, filePath: string) => Promise<JsonDurableQueueReadResult<T>>;
  maxBytes?: number;
}): Promise<T | null> {
  try {
    const pathsInput = params.paths;
    const paths = validateDurableQueueEntryPaths(pathsInput);
    const claimedPath = await claimDurableQueueEntry(paths);
    if (!claimedPath) return null;
    return await withJsonDurableQueueEntry<T, T>(claimedPath, {
      maxBytes: params.maxBytes,
    }, async (raw, identity, releaseReadPin) => {
      const read = params.read;
      const result = read ? await Reflect.apply(read, params, [raw, paths.jsonPath]) : { entry: raw };
      if (result.migrated) {
        await migrateClaimedQueueEntry({
          paths, identity, releaseReadPin, entry: result.entry, tempPrefix: params.tempPrefix,
        });
      }
      return result.entry;
    });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function loadPendingJsonDurableQueueEntries<T>(
  options: JsonDurableQueueLoadOptions<T>,
): Promise<T[]> {
  const queueDir = options.queueDir;
  assertNoWindowsPathAlias(queueDir);
  let files: string[];
  try {
    files = await fs.promises.readdir(queueDir);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }

  const now = Date.now();
  for (const file of files) {
    if (file.endsWith(".delivered")) {
      const id = file.slice(0, -".delivered".length);
      try { assertSafeQueueEntryId(id); } catch { continue; }
      const paths = validateDurableQueueEntryPaths(
        resolveJsonDurableQueueEntryPaths(queueDir, id),
      );
      await completeDeliveredQueueEntry(paths);
    } else if (options.cleanupTmpMaxAgeMs !== undefined && file.endsWith(".tmp")) {
      await unlinkStaleTmpBestEffort(
        path.join(queueDir, file),
        now,
        options.cleanupTmpMaxAgeMs,
      );
    }
  }
  const ids: string[] = [];
  const seenIds = new Set<string>();
  for (const file of files) {
    const suffix = file.endsWith(".processing")
      ? ".processing"
      : file.endsWith(".json")
        ? ".json"
        : null;
    if (!suffix) continue;
    const id = file.slice(0, -suffix.length);
    try { assertSafeQueueEntryId(id); } catch { continue; }
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    ids.push(id);
  }

  const entries: T[] = [];
  for (const id of ids) {
    const paths = validateDurableQueueEntryPaths(resolveJsonDurableQueueEntryPaths(queueDir, id));
    const claimedPath = await claimDurableQueueEntry(paths, { skipUnowned: true });
    if (!claimedPath) continue;
    let migrationStarted = false;
    try {
      const entry = await withJsonDurableQueueEntry<T, T>(
        claimedPath,
        { maxBytes: options.maxBytes },
        async (raw, identity, releaseReadPin) => {
          const read = options.read;
          const result = read ? await Reflect.apply(read, options, [raw, paths.jsonPath]) : { entry: raw };
          if (result.migrated) {
            migrationStarted = true;
            await migrateClaimedQueueEntry({
              paths, identity, releaseReadPin, entry: result.entry, tempPrefix: options.tempPrefix,
            });
          }
          return result.entry;
        },
      );
      entries.push(entry);
    } catch (error) {
      if (migrationStarted) throw error;
      continue;
    }
  }
  return entries;
}

export async function moveJsonDurableQueueEntryToFailed(params: {
  queueDir: string;
  failedDir: string;
  id: string;
}): Promise<void> {
  const id = params.id;
  const queueDir = params.queueDir;
  const failedDir = params.failedDir;
  assertSafeQueueEntryId(id);
  assertNoWindowsPathAlias(queueDir);
  assertNoWindowsPathAlias(failedDir);
  const roots = await queueValidationRoots(queueDir, failedDir);
  await assertJsonDurableQueueDir(queueDir, roots.queueRoot);
  await ensureJsonDurableQueueDir(failedDir, roots.failedRoot);
  const paths = validateDurableQueueEntryPaths(resolveJsonDurableQueueEntryPaths(queueDir, id));
  await moveDurableQueueEntryToFailed({
    paths,
    failedPath: path.join(failedDir, `${id}.json`),
  });
}
