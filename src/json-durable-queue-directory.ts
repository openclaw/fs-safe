import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "./directory-durability.js";
import { isPathRelativeEscape } from "./path.js";
import { realpathSync } from "./realpath.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import {
  assertNoWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

export async function queueDirectories(
  queueDir: string,
  failedDir: string,
): Promise<{ queue: QueueDirectory; failed: QueueDirectory }> {
  const queue = new QueueDirectory(queueDir);
  return { queue, failed: new QueueDirectory(failedDir) };
}

class QueueDirectory {
  private readonly root: string;
  private readonly allowSymlinkBase: boolean;

  constructor(private readonly dir: string) {
    this.root = path.parse(resolveQueueFilesystemPath(dir)).root;
    this.allowSymlinkBase = process.platform === "darwin";
  }

  async ensure(): Promise<void> {
    await this.assert(true);
    await fs.promises.mkdir(recursiveMkdirPath(this.dir), { recursive: true, mode: 0o700 });
    await this.assert();
    await chmodQueueDirectory(this.dir);
    await syncQueueDirectoryCreation(this.dir, this.root);
  }

  async assert(allowMissing = false): Promise<void> {
    const dir = this.dir;
    let base = resolveQueueFilesystemPath(this.root);
    let target = resolveQueueFilesystemPath(dir);
    let current = base;
    let baseStat = fs.lstatSync(base);
    if (baseStat.isSymbolicLink() && this.allowSymlinkBase) {
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
        if (stat.isSymbolicLink() && this.allowSymlinkBase) {
          if (await isDarwinSystemAlias(current, stat)) {
            current = realpathSync.native(current);
            continue;
          }
        }
        throw new Error(`durable queue path is not a directory: ${dir}`);
      }
    }
  }
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

function resolveQueueFilesystemPath(value: string): string {
  const resolved = resolvePathPreservingWindowsRoot(value);
  assertNoWindowsPathAlias(resolved);
  return resolved;
}

export async function syncQueueDirectoryCreation(
  dir: string,
  validationBase: string,
): Promise<void> {
  const baseReal = realpathSync.native(validationBase);
  const targetReal = realpathSync.native(dir);
  const relative = path.relative(baseReal, targetReal);
  if (isPathRelativeEscape(relative)) {
    throw new Error(`durable queue directory escapes validation base: ${dir}`);
  }

  const directories = [baseReal];
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    directories.push(path.join(directories.at(-1)!, segment));
  }

  await syncDirectory(targetReal, { label: "durable queue directory" });
  for (const parent of directories.slice(0, -1).toReversed()) {
    await syncDirectory(parent, { label: "durable queue parent" });
  }
}
