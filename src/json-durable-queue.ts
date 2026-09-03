import fs, { type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { normalizeMaxBytes } from "./byte-budget.js";
import { syncDirectory } from "./directory-durability.js";
import { syncQueueDirectoryCreation } from "./json-durable-queue-directory.js";
import {
  acknowledgeDurableQueueEntry,
  claimDurableQueueEntry,
  completeDeliveredQueueEntry,
  moveDurableQueueEntryToFailed,
} from "./json-durable-queue-ownership.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { replaceFileAtomic } from "./replace-file.js";
import { assertSafePathSegment } from "./safe-path-segment.js";
import { inspectFileIdentity } from "./strict-file-identity.js";

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

type QueueValidationRoot = {
  path: string;
  allowSymlinkBase: boolean;
};

export const DEFAULT_JSON_DURABLE_QUEUE_ENTRY_MAX_BYTES = 16 * 1024 * 1024;

function getErrnoCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}

function assertSafeQueueEntryId(id: string): void {
  assertSafePathSegment(id, { label: "queue entry id" });
}

export async function unlinkBestEffort(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath).catch(() => undefined);
}

export async function jsonDurableQueueEntryExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(filePath);
    return stat.isFile();
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
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
    const stat = await fs.promises.stat(filePath);
    if (stat.isFile() && now - stat.mtimeMs >= maxAgeMs) {
      await unlinkBestEffort(filePath);
    }
  } catch (error) {
    if (getErrnoCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

export function resolveJsonDurableQueueEntryPaths(
  queueDir: string,
  id: string,
): JsonDurableQueueEntryPaths {
  assertSafeQueueEntryId(id);
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
  const roots = await queueValidationRoots(params.queueDir, params.failedDir);
  await ensureJsonDurableQueueDir(params.queueDir, roots.queueRoot);
  await ensureJsonDurableQueueDir(params.failedDir, roots.failedRoot);
}

async function ensureJsonDurableQueueDir(
  dir: string,
  validationRoot?: QueueValidationRoot,
): Promise<void> {
  const root = validationRoot
    ? validationRoot
    : queueValidationRoot(dir);
  await assertNoSymlinkDirectorySegments(root, dir, true);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
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

function commonPathAncestor(paths: string[]): string {
  const resolved = paths.map((entry) => path.resolve(entry));
  const root = path.parse(resolved[0] ?? process.cwd()).root;
  const parts = resolved.map((entry) => path.relative(root, entry).split(path.sep));
  const common: string[] = [];
  for (let index = 0; parts.every((part) => index < part.length); index++) {
    const segment = parts[0]?.[index];
    if (!segment || !parts.every((part) => part[index] === segment)) break;
    common.push(segment);
  }
  return path.join(root, ...common);
}

function samePathRoot(paths: string[]): boolean {
  const roots = paths.map((entry) => path.parse(path.resolve(entry)).root);
  const first = process.platform === "win32" ? roots[0]?.toLowerCase() : roots[0];
  return roots.every((root) => (process.platform === "win32" ? root.toLowerCase() : root) === first);
}

async function queueValidationRoots(
  queueDir: string,
  failedDir: string,
): Promise<{ queueRoot: QueueValidationRoot; failedRoot: QueueValidationRoot }> {
  if (samePathRoot([queueDir, failedDir])) {
    const common = commonPathAncestor([queueDir, failedDir]);
    const root = queueValidationRoot(common);
    return { failedRoot: root, queueRoot: root };
  }
  return {
    failedRoot: queueValidationRoot(failedDir),
    queueRoot: queueValidationRoot(queueDir),
  };
}

function queueValidationRoot(dir: string): QueueValidationRoot {
  return {
    path: path.parse(path.resolve(dir)).root,
    allowSymlinkBase: process.platform === "darwin",
  };
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
  return await fs.promises.realpath(resolved).then(
    (realPath) => realPath === `/private${resolved}`,
    () => false,
  );
}

async function assertNoSymlinkDirectorySegments(
  validationRoot: QueueValidationRoot,
  dir: string,
  allowMissing: boolean,
): Promise<void> {
  let base = path.resolve(validationRoot.path);
  let target = path.resolve(dir);
  let current = base;
  let baseStat = await fs.promises.lstat(base);
  if (baseStat.isSymbolicLink() && validationRoot.allowSymlinkBase) {
    const relative = path.relative(base, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`durable queue path is not a directory: ${dir}`);
    }
    base = await fs.promises.realpath(base);
    target = path.join(base, ...relative.split(path.sep).filter(Boolean));
    current = base;
    baseStat = await fs.promises.lstat(base);
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
      stat = await fs.promises.lstat(current);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      if (stat.isSymbolicLink() && validationRoot.allowSymlinkBase) {
        if (await isDarwinSystemAlias(current, stat)) {
          current = await fs.promises.realpath(current);
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
      const stat = await handle.stat();
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
  const stat = await fs.promises.lstat(dir);
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
  await replaceFileAtomic({
    filePath: params.filePath,
    content: stringifyJsonDocument(params.entry, null, 2),
    mode: 0o600,
    tempPrefix: params.tempPrefix,
    syncTempFile: true,
    syncParentDir: true,
  });
}

async function replaceJsonDurableQueueEntry(params: {
  filePath: string;
  entry: unknown;
  tempPrefix: string;
}): Promise<void> {
  await replaceFileAtomic({
    filePath: params.filePath,
    content: stringifyJsonDocument(params.entry, null, 2),
    mode: 0o600,
    tempPrefix: params.tempPrefix,
    syncTempFile: true,
  });
  await syncDirectory(path.dirname(params.filePath));
}

async function inspectQueueEntry(
  inspect: () => Promise<BigIntStats>,
  maxBytes: number,
  expected?: BigIntStats,
): Promise<BigIntStats> {
  let inspectionFailed = false;
  try {
    return await inspectFileIdentity(async () => {
      try {
        const stat = await inspect();
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error("queue entry is not a regular file");
        }
        if (stat.nlink > 1n) throw new Error("queue entry hardlinks are not allowed");
        if (stat.size > maxBytes) throw new Error(`queue entry exceeds ${maxBytes} bytes`);
        return stat;
      } catch (error) {
        inspectionFailed = true;
        throw error;
      }
    }, expected);
  } catch (error) {
    // Translate only the identity helper's rejection, never inspection errors.
    if (inspectionFailed) throw error;
    throw new Error("queue entry changed during read", { cause: error });
  }
}

async function readBoundedUtf8File(params: {
  filePath: string;
  maxBytes: number;
}): Promise<string> {
  const inspectPath = () => fs.promises.lstat(params.filePath, { bigint: true });
  const initialStat = await inspectQueueEntry(inspectPath, params.maxBytes);
  const handle = await fs.promises.open(params.filePath, resolveReadOpenFlags());
  try {
    const openedStat = await inspectQueueEntry(
      () => handle.stat({ bigint: true }), params.maxBytes, initialStat,
    );
    await inspectQueueEntry(inspectPath, params.maxBytes, openedStat);
    const chunks: Buffer[] = [];
    const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, params.maxBytes + 1));
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, total).toString("utf8");
      }
      total += bytesRead;
      if (total > params.maxBytes) {
        throw new Error(`queue entry exceeds ${params.maxBytes} bytes`);
      }
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
  } finally {
    await handle.close();
  }
}

export async function readJsonDurableQueueEntry<T>(
  filePath: string,
  options: { maxBytes?: number } = {},
): Promise<T> {
  return JSON.parse(
    await readBoundedUtf8File({
      filePath,
      maxBytes: normalizeMaxBytes(options.maxBytes, {
        defaultValue: DEFAULT_JSON_DURABLE_QUEUE_ENTRY_MAX_BYTES,
      })!,
    }),
  ) as T;
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
    const claimedPath = await claimDurableQueueEntry(params.paths);
    if (!claimedPath) return null;
    const raw = await readJsonDurableQueueEntry<T>(claimedPath, {
      maxBytes: params.maxBytes,
    });
    const result = params.read ? await params.read(raw, params.paths.jsonPath) : { entry: raw };
    if (result.migrated) {
      await replaceJsonDurableQueueEntry({
        filePath: claimedPath,
        entry: result.entry,
        tempPrefix: params.tempPrefix,
      });
    }
    return result.entry;
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function loadPendingJsonDurableQueueEntries<T>(
  options: JsonDurableQueueLoadOptions<T>,
): Promise<T[]> {
  let files: string[];
  try {
    files = await fs.promises.readdir(options.queueDir);
  } catch (error) {
    if (getErrnoCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }

  const now = Date.now();
  for (const file of files) {
    if (file.endsWith(".delivered")) {
      const id = file.slice(0, -".delivered".length);
      await completeDeliveredQueueEntry(resolveJsonDurableQueueEntryPaths(options.queueDir, id));
    } else if (options.cleanupTmpMaxAgeMs !== undefined && file.endsWith(".tmp")) {
      await unlinkStaleTmpBestEffort(
        path.join(options.queueDir, file),
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
    const paths = resolveJsonDurableQueueEntryPaths(options.queueDir, id);
    const claimedPath = await claimDurableQueueEntry(paths, { skipUnowned: true });
    if (!claimedPath) continue;
    let result: JsonDurableQueueReadResult<T>;
    try {
      const raw = await readJsonDurableQueueEntry<T>(claimedPath, { maxBytes: options.maxBytes });
      result = options.read ? await options.read(raw, paths.jsonPath) : { entry: raw };
    } catch {
      continue;
    }
    if (result.migrated) {
      await replaceJsonDurableQueueEntry({
        filePath: claimedPath,
        entry: result.entry,
        tempPrefix: options.tempPrefix,
      });
    }
    entries.push(result.entry);
  }
  return entries;
}

export async function moveJsonDurableQueueEntryToFailed(params: {
  queueDir: string;
  failedDir: string;
  id: string;
}): Promise<void> {
  assertSafeQueueEntryId(params.id);
  const roots = await queueValidationRoots(params.queueDir, params.failedDir);
  await assertJsonDurableQueueDir(params.queueDir, roots.queueRoot);
  await ensureJsonDurableQueueDir(params.failedDir, roots.failedRoot);
  await moveDurableQueueEntryToFailed({
    paths: resolveJsonDurableQueueEntryPaths(params.queueDir, params.id),
    failedPath: path.join(params.failedDir, `${params.id}.json`),
  });
}
