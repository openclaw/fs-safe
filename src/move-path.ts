import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { guardedRename } from "./guarded-mutation.js";

export type MovePathWithCopyFallbackOptions = {
  from: string;
  sourceHardlinks?: "allow" | "reject";
  to: string;
};

type MoveCopyFallbackReason = "cross-device" | "windows-rename-denied";

export function moveCopyFallbackReasonForRenameError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): MoveCopyFallbackReason | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EXDEV") {
    return "cross-device";
  }
  if (code === "EPERM" && platform === "win32") {
    return "windows-rename-denied";
  }
  return undefined;
}

type EntryIdentity = {
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  size: number;
};

type CopiedEntryManifest =
  | (EntryIdentity & {
      children: Array<{ name: string; manifest: CopiedEntryManifest }>;
      kind: "directory";
    })
  | (EntryIdentity & { kind: "leaf" });

type CleanupCopiedEntryResult = "removed" | "stale";

function entryIdentity(stat: {
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  size: number;
}): EntryIdentity {
  return {
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function sameIdentity(a: EntryIdentity, b: EntryIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function sameDirectoryNode(a: EntryIdentity, b: EntryIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

function sourceChangedError(sourcePath: string): Error {
  return Object.assign(new Error(`Source changed during move fallback: ${sourcePath}`), {
    code: "ESTALE",
  });
}

async function assertSourceStillMatches(
  sourcePath: string,
  identity: EntryIdentity,
): Promise<void> {
  if (!sameIdentity(identity, entryIdentity(await fs.lstat(sourcePath)))) {
    throw sourceChangedError(sourcePath);
  }
}

function regularReadFlags(): number {
  return (
    fsConstants.O_RDONLY |
    (typeof fsConstants.O_NOFOLLOW === "number" && process.platform !== "win32"
      ? fsConstants.O_NOFOLLOW
      : 0)
  );
}

async function writeAll(handle: FileHandle, buffer: Buffer, bytesRead: number): Promise<void> {
  let offset = 0;
  while (offset < bytesRead) {
    const { bytesWritten } = await handle.write(buffer, offset, bytesRead - offset);
    offset += bytesWritten;
  }
}

async function copyRegularFilePinned(params: {
  from: string;
  identity: EntryIdentity;
  mode: number;
  to: string;
}): Promise<void> {
  let destinationCreated = false;
  let sourceHandle: FileHandle;
  try {
    sourceHandle = await fs.open(params.from, regularReadFlags());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ELOOP" || code === "ENOENT" || code === "ENOTDIR") {
      throw sourceChangedError(params.from);
    }
    throw error;
  }
  try {
    const openedStat = await sourceHandle.stat();
    if (!openedStat.isFile() || !sameIdentity(params.identity, entryIdentity(openedStat))) {
      throw sourceChangedError(params.from);
    }

    const destinationHandle = await fs.open(
      params.to,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      modeBits(params.mode) || 0o666,
    );
    destinationCreated = true;
    try {
      const scratch = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        const { bytesRead } = await sourceHandle.read(scratch, 0, scratch.length, null);
        if (bytesRead === 0) {
          break;
        }
        await writeAll(destinationHandle, scratch, bytesRead);
      }
    } finally {
      await destinationHandle.close();
    }

    // Re-check the opened handle before the staged tree can be committed. If
    // the source changed while we copied, the caller should retry the move.
    if (!sameIdentity(params.identity, entryIdentity(await sourceHandle.stat()))) {
      throw sourceChangedError(params.from);
    }
    await fs.chmod(params.to, modeBits(params.mode)).catch(() => undefined);
  } catch (error) {
    if (destinationCreated) {
      await fs.rm(params.to, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await sourceHandle.close();
  }
}

async function copyEntryWithManifest(
  from: string,
  to: string,
  options: { sourceHardlinks: "allow" | "reject" },
): Promise<CopiedEntryManifest> {
  const sourceStat = await fs.lstat(from);
  const identity = entryIdentity(sourceStat);

  if (sourceStat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(from), to);
    // readlink() is path-based; verify the symlink we copied is still the one
    // we inspected before letting the staged destination become visible.
    await assertSourceStillMatches(from, identity);
    return { ...identity, kind: "leaf" };
  }

  if (sourceStat.isDirectory()) {
    await fs.mkdir(to, { mode: modeBits(sourceStat.mode) || 0o755 });
    const children: Array<{ name: string; manifest: CopiedEntryManifest }> = [];
    for (const child of await fs.readdir(from)) {
      children.push({
        name: child,
        manifest: await copyEntryWithManifest(path.join(from, child), path.join(to, child), options),
      });
    }
    // Directory traversal is path-based in Node. Treat a changed parent as a
    // stale move before committing so swapped-in outside trees are not imported.
    await assertSourceStillMatches(from, identity);
    // mkdir() honors process umask. Restore the source mode before commit so
    // EXDEV fallback preserves directory permissions like fs.cp did.
    await fs.chmod(to, modeBits(sourceStat.mode));
    return { ...identity, children, kind: "directory" };
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Refusing to move non-file path with copy fallback: ${from}`);
  }
  if (options.sourceHardlinks === "reject" && sourceStat.nlink > 1) {
    throw new Error(`Refusing to move hardlinked file with copy fallback: ${from}`);
  }

  await copyRegularFilePinned({ from, identity, mode: sourceStat.mode, to });
  return { ...identity, kind: "leaf" };
}

function mergeCleanupResults(
  a: CleanupCopiedEntryResult,
  b: CleanupCopiedEntryResult,
): CleanupCopiedEntryResult {
  return a === "stale" || b === "stale" ? "stale" : "removed";
}

async function cleanupCopiedEntry(
  sourcePath: string,
  manifest: CopiedEntryManifest,
): Promise<CleanupCopiedEntryResult> {
  let currentStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    currentStat = await fs.lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return "removed";
    }
    throw error;
  }

  if (manifest.kind === "directory") {
    if (!currentStat.isDirectory() || !sameDirectoryNode(manifest, entryIdentity(currentStat))) {
      return "stale";
    }
    // A same-inode directory can gain unrelated children after commit. Still
    // clean manifest children so the fallback does not duplicate copied files.
    let result: CleanupCopiedEntryResult = "removed";
    for (const child of manifest.children) {
      result = mergeCleanupResults(
        result,
        await cleanupCopiedEntry(path.join(sourcePath, child.name), child.manifest),
      );
    }
    try {
      await fs.rmdir(sourcePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        return "stale";
      }
      throw error;
    }
    return result;
  }

  if (!sameIdentity(manifest, entryIdentity(currentStat))) {
    return "stale";
  }
  await fs.unlink(sourcePath);
  return "removed";
}

export async function movePathWithCopyFallback(
  options: MovePathWithCopyFallbackOptions,
): Promise<void> {
  let fallbackReason: MoveCopyFallbackReason | undefined;
  try {
    await guardedRename({ from: options.from, to: options.to });
    return;
  } catch (error) {
    fallbackReason = moveCopyFallbackReasonForRenameError(error);
    if (!fallbackReason) {
      throw error;
    }
  }
  const targetDir = path.dirname(path.resolve(options.to));
  const staged = path.join(targetDir, `.fs-safe-move-${process.pid}-${randomUUID()}.tmp`);
  try {
    const manifest = await copyEntryWithManifest(options.from, staged, {
      sourceHardlinks: options.sourceHardlinks ?? "allow",
    });
    await guardedRename({ from: staged, to: options.to });
    const cleanupResult = await cleanupCopiedEntry(options.from, manifest);
    if (cleanupResult === "stale") {
      throw sourceChangedError(options.from);
    }
  } finally {
    await fs.rm(staged, { recursive: true, force: true }).catch(() => undefined);
  }
}
