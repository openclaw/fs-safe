import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { guardedRename } from "./guarded-mutation.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { registerTempPathForExit } from "./temp-cleanup.js";

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
  nlink: number;
  size: number;
};

type CopiedEntryManifest =
  | (EntryIdentity & {
      children: Array<{ name: string; manifest: CopiedEntryManifest }>;
      kind: "directory";
    })
  | (EntryIdentity & { kind: "leaf" });

type CleanupCopiedEntryResult = "removed" | "stale";

const MAX_HARDLINK_PREFLIGHT_ENTRIES = 50_000;

function hardlinkedSourceError(sourcePath: string): FsSafeError {
  return new FsSafeError("hardlink", `Refusing to move hardlinked file: ${sourcePath}`);
}

function hardlinkWalkTooLargeError(): FsSafeError {
  return new FsSafeError(
    "too-large",
    `Source hardlink preflight exceeds ${MAX_HARDLINK_PREFLIGHT_ENTRIES} entries`,
  );
}

async function preflightSourceHardlinks(sourcePath: string): Promise<void> {
  const pending = [sourcePath];
  let discovered = 1;

  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = await fs.lstat(current);
    if (stat.isFile() && stat.nlink > 1) {
      throw hardlinkedSourceError(current);
    }
    if (!stat.isDirectory()) {
      continue;
    }
    const directory = await fs.opendir(current);
    for await (const entry of directory) {
      discovered += 1;
      if (discovered > MAX_HARDLINK_PREFLIGHT_ENTRIES) {
        throw hardlinkWalkTooLargeError();
      }
      pending.push(path.join(current, entry.name));
    }
  }
}

function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

async function assertCopyDestinationOutsideSource(sourcePath: string, targetPath: string) {
  const sourceReal = await fs.realpath(sourcePath);
  const normalizedTarget = path.resolve(targetPath);
  const targetParentReal = await fs.realpath(path.dirname(normalizedTarget));
  const targetCandidate = path.join(targetParentReal, path.basename(normalizedTarget));
  if (isSameOrDescendant(sourceReal, targetCandidate)) {
    throw new FsSafeError("invalid-path", "Move destination must not be inside the source");
  }
}

function entryIdentity(stat: {
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  nlink: number;
  size: number;
}): EntryIdentity {
  return {
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    nlink: stat.nlink,
    size: stat.size,
  };
}

function sameIdentity(a: EntryIdentity, b: EntryIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
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

async function chmodDirectoryPinned(directoryPath: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    // Node cannot portably open a Windows directory for descriptor-bound
    // chmod. POSIX modes are not enforced there, so do not fall back to a
    // pathname operation that could follow a replacement symlink.
    return;
  }
  const handle = await fs.open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
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
  rejectHardlinks: boolean;
  to: string;
}): Promise<void> {
  let destinationCreated = false;
  let sourceHandle: FileHandle;
  try {
    sourceHandle = await fs.open(params.from, resolveReadOpenFlags());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ELOOP" || code === "ENOENT" || code === "ENOTDIR") {
      throw sourceChangedError(params.from);
    }
    throw error;
  }
  try {
    const openedStat = await sourceHandle.stat();
    if (params.rejectHardlinks && openedStat.nlink > 1) {
      throw hardlinkedSourceError(params.from);
    }
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
      // Re-check the opened source before the staged tree can be committed. If
      // it changed while we copied, the caller should retry the move.
      const finalSourceStat = await sourceHandle.stat();
      if (params.rejectHardlinks && finalSourceStat.nlink > 1) {
        throw hardlinkedSourceError(params.from);
      }
      if (!sameIdentity(params.identity, entryIdentity(finalSourceStat))) {
        throw sourceChangedError(params.from);
      }
      await destinationHandle.chmod(modeBits(params.mode));
    } finally {
      await destinationHandle.close();
    }
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
  options: {
    sourceHardlinks: "allow" | "reject";
    budget?: { discovered: number };
  },
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
    const childNames: string[] = [];
    const directory = await fs.opendir(from);
    for await (const entry of directory) {
      if (options.budget && ++options.budget.discovered > MAX_HARDLINK_PREFLIGHT_ENTRIES) {
        throw hardlinkWalkTooLargeError();
      }
      childNames.push(entry.name);
    }
    for (const child of childNames) {
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
    await chmodDirectoryPinned(to, modeBits(sourceStat.mode));
    return { ...identity, children, kind: "directory" };
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Refusing to move non-file path with copy fallback: ${from}`);
  }
  if (options.sourceHardlinks === "reject" && sourceStat.nlink > 1) {
    throw hardlinkedSourceError(from);
  }

  await copyRegularFilePinned({
    from,
    identity,
    mode: sourceStat.mode,
    rejectHardlinks: options.sourceHardlinks === "reject",
    to,
  });
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
  const sourcePath = path.resolve(options.from);
  const targetPath = path.resolve(options.to);
  const rejectHardlinks = options.sourceHardlinks === "reject";
  if (rejectHardlinks) {
    await preflightSourceHardlinks(sourcePath);
  }

  if (!rejectHardlinks) {
    try {
      await guardedRename({ from: sourcePath, to: targetPath });
      return;
    } catch (error) {
      if (!moveCopyFallbackReasonForRenameError(error)) {
        throw error;
      }
    }
  } else {
    // A pathname preflight cannot make nlink and rename one atomic operation.
    // Commit a fresh inode through the copy path so a post-scan hardlink can
    // never become the published target; the copy loop fences nlink again.
  }
  await assertCopyDestinationOutsideSource(sourcePath, targetPath);
  const targetDir = path.dirname(targetPath);
  const staged = path.join(targetDir, `.fs-safe-move-${process.pid}-${randomUUID()}.tmp`);
  const unregisterStaged = registerTempPathForExit(staged, { recursive: true });
  let stagedCommitted = false;
  try {
    const manifest = await copyEntryWithManifest(sourcePath, staged, {
      sourceHardlinks: options.sourceHardlinks ?? "allow",
      ...(rejectHardlinks ? { budget: { discovered: 1 } } : {}),
    });
    unregisterStaged.setIdentity(await fs.lstat(staged, { bigint: true }));
    await assertCopyDestinationOutsideSource(sourcePath, targetPath);
    await guardedRename({ from: staged, to: targetPath });
    stagedCommitted = true;
    unregisterStaged();
    const cleanupResult = await cleanupCopiedEntry(sourcePath, manifest);
    if (cleanupResult === "stale") {
      throw sourceChangedError(sourcePath);
    }
  } finally {
    if (!stagedCommitted) {
      try {
        const stagedIdentity = await fs.lstat(staged, { bigint: true });
        if (!stagedIdentity.isSymbolicLink()) unregisterStaged.setIdentity(stagedIdentity);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          unregisterStaged();
        }
      }
      try {
        await fs.rm(staged, { recursive: true, force: true });
        unregisterStaged();
      } catch {
        // Keep the identity-bound exit cleanup registered for a later retry.
      }
    }
  }
}
