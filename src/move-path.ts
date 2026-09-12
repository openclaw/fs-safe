import { randomUUID } from "node:crypto";
import fsSync, { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { createAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { guardedRename } from "./guarded-mutation.js";
import {
  assertSourceStillMatches,
  cleanupCopiedEntry,
  createCleanupCopiedEntryState,
  entryIdentity,
  sameIdentity,
  sourceChangedError,
  type CopiedEntryManifest,
  type EntryIdentity,
} from "./move-path-cleanup.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { cleanupPinnedFilePath } from "./replace-file-temp-owner.js";
import { createMoveStageOwner } from "./move-path-stage.js";

export type MovePathPublicationReceipt = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
}>;

export type MovePathWithCopyFallbackOptions = {
  /** Rechecks authority before each rename and copied-source unlink/rmdir dispatch. */
  assertBeforeMutation?: () => void;
  /** Rechecks caller authority synchronously immediately before each rename dispatch. */
  assertBeforeRename?: () => void;
  /** Reports the committed destination before post-rename checks or source cleanup. */
  onDestinationPublished?: (receipt: MovePathPublicationReceipt) => void;
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
    const stat = fsSync.lstatSync(current);
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

async function assertCopyDestinationOutsideSource(
  sourcePath: string,
  targetPath: string,
  expectedIdentity?: EntryIdentity,
): Promise<EntryIdentity> {
  const sourceStat = fsSync.lstatSync(sourcePath);
  const sourceIdentity = entryIdentity(sourceStat);
  if (expectedIdentity && !sameIdentity(expectedIdentity, sourceIdentity)) {
    throw sourceChangedError(sourcePath);
  }
  const normalizedSource = path.resolve(sourcePath);
  const normalizedTarget = path.resolve(targetPath);
  const sourceParentReal = fsSync.realpathSync.native(path.dirname(normalizedSource));
  const targetParentReal = fsSync.realpathSync.native(path.dirname(normalizedTarget));
  const sourceCandidate = path.join(sourceParentReal, path.basename(normalizedSource));
  const targetCandidate = path.join(targetParentReal, path.basename(normalizedTarget));
  const sourceBoundary = sourceStat.isDirectory()
    ? fsSync.realpathSync.native(sourcePath)
    : sourceCandidate;
  const unsafeTarget = sourceStat.isDirectory()
    ? isSameOrDescendant(sourceBoundary, targetCandidate)
    : path.relative(sourceBoundary, targetCandidate) === "";
  if (unsafeTarget) {
    throw new FsSafeError("invalid-path", "Move destination must not be inside the source");
  }
  return sourceIdentity;
}

function modeBits(mode: number): number {
  return mode & 0o777;
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
    if (bytesWritten <= 0) throw new FsSafeError("helper-failed", "move copy made no progress");
    offset += bytesWritten;
  }
}

async function copyRegularFilePinned(params: {
  from: string;
  identity: EntryIdentity;
  mode: number;
  rejectHardlinks: boolean;
  to: string;
  onCreated?: (identity: fsSync.BigIntStats) => void;
}): Promise<EntryIdentity> {
  let openedIdentity: EntryIdentity;
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
    const openedStat = fsSync.fstatSync(sourceHandle.fd);
    openedIdentity = entryIdentity(openedStat);
    if (params.rejectHardlinks && openedStat.nlink > 1) {
      throw hardlinkedSourceError(params.from);
    }
    const openAdvancedWindowsCtime =
      process.platform === "win32" &&
      params.identity.dev === openedIdentity.dev &&
      params.identity.ino === openedIdentity.ino &&
      params.identity.mode === openedIdentity.mode &&
      params.identity.nlink === openedIdentity.nlink &&
      params.identity.size === openedIdentity.size &&
      params.identity.mtimeMs === openedIdentity.mtimeMs &&
      openedIdentity.ctimeMs >= params.identity.ctimeMs;
    if (
      !openedStat.isFile() ||
      (!sameIdentity(params.identity, openedIdentity) && !openAdvancedWindowsCtime)
    ) {
      throw sourceChangedError(params.from);
    }
    await assertSourceStillMatches(params.from, openedIdentity);

    const parentGuard = await createAsyncDirectoryGuard(path.dirname(params.to), { bigint: true });
    const destinationHandle = await fs.open(
      params.to,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      modeBits(params.mode) || 0o666,
    );
    let destinationIdentity: fsSync.BigIntStats | undefined;
    try {
      destinationIdentity = fsSync.fstatSync(destinationHandle.fd, { bigint: true });
      params.onCreated?.(destinationIdentity);
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
      const finalSourceStat = fsSync.fstatSync(sourceHandle.fd);
      if (params.rejectHardlinks && finalSourceStat.nlink > 1) {
        throw hardlinkedSourceError(params.from);
      }
      if (!sameIdentity(openedIdentity, entryIdentity(finalSourceStat))) {
        throw sourceChangedError(params.from);
      }
      await destinationHandle.chmod(modeBits(params.mode));
    } catch (error) {
      await cleanupPinnedFilePath({
        pathname: params.to, handle: destinationHandle, identity: destinationIdentity, parentGuard,
      });
      throw error;
    } finally {
      await destinationHandle.close();
    }
  } finally {
    await sourceHandle.close();
  }
  return openedIdentity;
}

async function copyEntryWithManifest(
  from: string,
  to: string,
  options: {
    sourceHardlinks: "allow" | "reject";
    budget?: { discovered: number };
    onCreated?: (identity: fsSync.BigIntStats) => void;
  },
  expectedIdentity?: EntryIdentity,
): Promise<CopiedEntryManifest> {
  const sourceStat = fsSync.lstatSync(from);
  const identity = entryIdentity(sourceStat);
  if (expectedIdentity && !sameIdentity(expectedIdentity, identity)) {
    throw sourceChangedError(from);
  }

  if (sourceStat.isSymbolicLink()) {
    const target = await fs.readlink(from);
    const targetType =
      process.platform === "win32" && fsSync.statSync(from).isDirectory() ? "junction" : undefined;
    await fs.symlink(target, to, targetType);
    options.onCreated?.(fsSync.lstatSync(to, { bigint: true }));
    // readlink() is path-based; verify the symlink we copied is still the one
    // we inspected before letting the staged destination become visible.
    await assertSourceStillMatches(from, identity);
    return { ...identity, kind: "leaf" };
  }

  if (sourceStat.isDirectory()) {
    await fs.mkdir(to, { mode: modeBits(sourceStat.mode) || 0o755 });
    options.onCreated?.(fsSync.lstatSync(to, { bigint: true }));
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
        manifest: await copyEntryWithManifest(path.join(from, child), path.join(to, child), {
          sourceHardlinks: options.sourceHardlinks, budget: options.budget,
        }),
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

  const copiedIdentity = await copyRegularFilePinned({
    from,
    identity,
    mode: sourceStat.mode,
    rejectHardlinks: options.sourceHardlinks === "reject",
    to,
    onCreated: options.onCreated,
  });
  return { ...copiedIdentity, kind: "leaf" };
}

function assertSynchronousResult(returned: unknown, name: string): void {
  if (returned !== undefined) {
    // TypeScript permits async functions for () => void; consume their rejection.
    void Promise.resolve(returned).catch(() => {});
    throw new TypeError(`${name} must return undefined synchronously`);
  }
}

export async function movePathWithCopyFallback(
  options: MovePathWithCopyFallbackOptions,
): Promise<void> {
  // Keep the initiating owner's callbacks across preparation and copy fallback.
  const callerRenameAssert = options.assertBeforeRename;
  const callerMutationAssert = options.assertBeforeMutation;
  const callerPublished = options.onDestinationPublished;
  let assertionRejected = false;
  let destinationPublished = false;
  const assertBeforeMutation = () => {
    assertSynchronousResult(callerMutationAssert?.(), "assertBeforeMutation");
  };
  const assertBeforeRename = () => {
    try {
      assertSynchronousResult(callerRenameAssert?.(), "assertBeforeRename");
      assertBeforeMutation();
    } catch (error) {
      assertionRejected = true;
      throw error;
    }
  };
  let publicationReceipt: MovePathPublicationReceipt | undefined;
  const onSourceInspected = callerPublished
    ? (identity: { dev: bigint; ino: bigint }) => {
        publicationReceipt = Object.freeze({
          path: targetPath,
          dev: identity.dev,
          ino: identity.ino,
        });
      }
    : undefined;
  const onRenamed = () => {
    destinationPublished = true;
    if (publicationReceipt) {
      assertSynchronousResult(callerPublished?.(publicationReceipt), "onDestinationPublished");
    }
  };
  const sourcePath = path.resolve(options.from);
  const targetPath = path.resolve(options.to);
  const rejectHardlinks = options.sourceHardlinks === "reject";
  if (rejectHardlinks) {
    await preflightSourceHardlinks(sourcePath);
  }

  if (!rejectHardlinks) {
    try {
      await guardedRename({
        from: sourcePath,
        to: targetPath,
        assertBeforeRename,
        onSourceInspected,
        onRenamed,
      });
      return;
    } catch (error) {
      // An owner's EXDEV/EPERM refusal is not permission to copy instead.
      if (assertionRejected || destinationPublished || !moveCopyFallbackReasonForRenameError(error)) {
        throw error;
      }
    }
  } else {
    // A pathname preflight cannot make nlink and rename one atomic operation.
    // Commit a fresh inode through the copy path so a post-scan hardlink can
    // never become the published target; the copy loop fences nlink again.
  }
  const sourceIdentity = await assertCopyDestinationOutsideSource(sourcePath, targetPath);
  const targetDir = path.dirname(targetPath);
  const staged = path.join(targetDir, `.fs-safe-move-${process.pid}-${randomUUID()}.tmp`);
  const stage = await createMoveStageOwner(staged);
  try {
    const manifest = await copyEntryWithManifest(
      sourcePath,
      staged,
      {
        sourceHardlinks: rejectHardlinks ? "reject" : "allow",
        onCreated: stage.record,
        ...(rejectHardlinks ? { budget: { discovered: 1 } } : {}),
      },
      sourceIdentity,
    );
    const cleanupState = createCleanupCopiedEntryState(sourcePath, manifest);
    await assertCopyDestinationOutsideSource(sourcePath, targetPath, manifest);
    await guardedRename({
      from: staged,
      to: targetPath,
      assertBeforeRename: () => { assertBeforeRename(); stage.assertCurrent(); },
      onSourceInspected,
      onRenamed: () => {
        stage.published();
        onRenamed();
      },
    });
    const cleanupResult = await cleanupCopiedEntry(
      sourcePath,
      manifest,
      cleanupState,
      assertBeforeMutation,
    );
    if (cleanupResult === "stale") {
      throw sourceChangedError(sourcePath);
    }
  } finally {
    if (!destinationPublished) {
      await stage.cleanup();
    }
  }
}
