import { randomUUID } from "node:crypto";
import fsSync, { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { assertSyncDirectoryGuard, createAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { guardedRename } from "./guarded-mutation.js";
import {
  assertSourceStillMatches,
  cleanupCopiedEntry,
  createCleanupCopiedEntryState,
  entryIdentity,
  inspectSourceDirectory,
  inspectSourceEntry,
  sameIdentity,
  sourceChangedError,
  type CopiedEntryManifest,
  type EntryIdentity,
} from "./move-path-cleanup.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { realpathSync } from "./realpath.js";
import { cleanupPinnedFilePath } from "./file-cleanup.js";
import { createMoveStageOwner } from "./move-path-stage.js";
import { admitStandalonePublicationPath, assertNoWindowsPathAlias } from "./windows-path-alias.js";

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
type CopiedFileManifest = EntryIdentity & { kind: "leaf" };

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
  const sourceStat = inspectSourceEntry(sourcePath, () => fsSync.lstatSync(sourcePath, { bigint: true }));
  const sourceIdentity = entryIdentity(sourceStat);
  if (expectedIdentity && !sameIdentity(expectedIdentity, sourceIdentity)) {
    throw sourceChangedError(sourcePath);
  }
  const normalizedSource = path.resolve(sourcePath);
  const normalizedTarget = path.resolve(targetPath);
  const sourceParentReal = realpathSync.native(path.dirname(normalizedSource));
  const targetParentReal = realpathSync.native(path.dirname(normalizedTarget));
  const sourceCandidate = path.join(sourceParentReal, path.basename(normalizedSource));
  const targetCandidate = path.join(targetParentReal, path.basename(normalizedTarget));
  const sourceBoundary = sourceStat.isDirectory()
    ? realpathSync.native(sourcePath)
    : sourceCandidate;
  const unsafeTarget = sourceStat.isDirectory()
    ? isSameOrDescendant(sourceBoundary, targetCandidate)
    : path.relative(sourceBoundary, targetCandidate) === "";
  if (unsafeTarget) {
    throw new FsSafeError("invalid-path", "Move destination must not be inside the source");
  }
  return sourceIdentity;
}

function modeBits(mode: bigint): number {
  return Number(mode & 0o777n);
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
  mode: bigint;
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
    const inspectOpenedSource = () => inspectSourceEntry(params.from, () => {
      const stat = fsSync.fstatSync(sourceHandle.fd, { bigint: true });
      if (params.rejectHardlinks && stat.nlink > 1n) throw hardlinkedSourceError(params.from);
      if (!stat.isFile()) throw sourceChangedError(params.from);
      return stat;
    });
    const openedStat = inspectOpenedSource();
    openedIdentity = entryIdentity(openedStat);
    const openAdvancedWindowsCtime =
      process.platform === "win32" &&
      params.identity.dev === openedIdentity.dev &&
      params.identity.ino === openedIdentity.ino &&
      params.identity.mode === openedIdentity.mode &&
      params.identity.nlink === openedIdentity.nlink &&
      params.identity.size === openedIdentity.size &&
      params.identity.mtimeNs === openedIdentity.mtimeNs &&
      openedIdentity.ctimeNs >= params.identity.ctimeNs;
    if (
      !sameIdentity(params.identity, openedIdentity) && !openAdvancedWindowsCtime
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
      if (!sameIdentity(openedIdentity, inspectOpenedSource())) {
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
    aliases?: Map<string, CopiedFileManifest>;
  },
  expectedIdentity?: EntryIdentity,
): Promise<CopiedEntryManifest> {
  const sourceStat = inspectSourceEntry(from, () => fsSync.lstatSync(from, { bigint: true }));
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
    const directoryIdentity = Object.freeze({ dev: sourceStat.dev, ino: sourceStat.ino });
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
          aliases: options.aliases,
        }),
      });
    }
    // Directory traversal is path-based in Node. Treat a changed parent as a
    // stale move before committing so swapped-in outside trees are not imported.
    await assertSourceStillMatches(from, identity);
    inspectSourceDirectory(from, directoryIdentity);
    // mkdir() honors process umask. Restore the source mode before commit so
    // EXDEV fallback preserves directory permissions like fs.cp did.
    await chmodDirectoryPinned(to, modeBits(sourceStat.mode));
    return { ...identity, children, directoryIdentity, kind: "directory" };
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Refusing to move non-file path with copy fallback: ${from}`);
  }
  if (options.sourceHardlinks === "reject" && sourceStat.nlink > 1n) {
    throw hardlinkedSourceError(from);
  }

  const aliasKey = options.aliases && identity.nlink > 1n ? `${identity.dev}:${identity.ino}` : undefined;
  const alias = aliasKey ? options.aliases!.get(aliasKey) : undefined;
  if (alias && !sameIdentity(alias, identity)) throw sourceChangedError(from);

  const copiedIdentity = await copyRegularFilePinned({
    from,
    identity,
    mode: sourceStat.mode,
    rejectHardlinks: options.sourceHardlinks === "reject",
    to,
    onCreated: options.onCreated,
  });
  // A permitted Windows open advances every name's ctime. Share its receipt
  // only after the preceding fingerprint and this complete copy were verified.
  if (alias) return Object.assign(alias, copiedIdentity);
  const manifest: CopiedFileManifest = { ...copiedIdentity, kind: "leaf" };
  if (aliasKey) options.aliases!.set(aliasKey, manifest);
  return manifest;
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
  const from = admitStandalonePublicationPath(
    options.from,
    "move source uses a Windows filesystem namespace alias",
  );
  const to = admitStandalonePublicationPath(
    options.to,
    "move destination uses a Windows filesystem namespace alias",
  );
  const sourcePath = path.resolve(from);
  const targetPath = path.resolve(to);
  assertNoWindowsPathAlias(sourcePath, "filesystem", "move source uses a Windows filesystem namespace alias");
  assertNoWindowsPathAlias(targetPath, "filesystem", "move destination uses a Windows filesystem namespace alias");
  const sourceHardlinks = options.sourceHardlinks;
  // Keep the initiating owner's callbacks across preparation and copy fallback.
  const callerRenameAssert = options.assertBeforeRename;
  const callerMutationAssert = options.assertBeforeMutation;
  const callerPublished = options.onDestinationPublished;
  let assertionRejected = false;
  let destinationPublished = false;
  const assertBeforeMutation = callerMutationAssert == null ? undefined : () => {
    assertSynchronousResult(callerMutationAssert(), "assertBeforeMutation");
  };
  const assertBeforeRename = () => {
    try {
      assertSynchronousResult(callerRenameAssert?.(), "assertBeforeRename");
      assertBeforeMutation?.();
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
  const rejectHardlinks = sourceHardlinks === "reject";
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
  const sourceParentPath = path.dirname(sourcePath);
  const sourceParent = assertBeforeMutation || callerRenameAssert || callerPublished
    ? await createAsyncDirectoryGuard(realpathSync.native(sourceParentPath), { bigint: true })
    : undefined;
  const assertSourceParent = sourceParent ? () => {
    try {
      if (realpathSync.native(sourceParentPath) !== sourceParent.realPath) throw sourceChangedError(sourcePath);
      assertSyncDirectoryGuard(sourceParent);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" ||
        (error instanceof FsSafeError && (error.code === "path-mismatch" || error.code === "not-file"))) {
        throw sourceChangedError(sourcePath);
      }
      throw error;
    }
  } : undefined;
  const assertBeforeCleanup = assertSourceParent ? () => {
    assertBeforeMutation?.();
    assertSourceParent();
  } : undefined;
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
        ...(!rejectHardlinks && process.platform === "win32" ? { aliases: new Map<string, CopiedFileManifest>() } : {}),
        ...(rejectHardlinks ? { budget: { discovered: 1 } } : {}),
      },
      sourceIdentity,
    );
    const cleanupState = createCleanupCopiedEntryState(sourcePath, manifest);
    await assertCopyDestinationOutsideSource(sourcePath, targetPath, manifest);
    if (manifest.kind === "directory") inspectSourceDirectory(sourcePath, manifest.directoryIdentity);
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
    assertSourceParent?.();
    const cleanupResult = await cleanupCopiedEntry(
      sourcePath,
      manifest,
      cleanupState,
      assertBeforeCleanup,
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
