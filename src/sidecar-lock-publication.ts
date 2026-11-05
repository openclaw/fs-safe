import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { sidecarStagingPath, cleanupSidecarStages } from "./sidecar-lock-staging.js";
import { assertExclusiveCreateLeaf } from "./exclusive-create.js";
import { createSuppressedError } from "./suppressed-error.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity, sameFileIdentityForCleanup } from "./file-identity.js";
import { readSidecarLockRawSnapshotSync } from "./sidecar-lock-reclaim.js";
import { isHardlinkFallbackError } from "./hardlink-fallback.js";
import { getNativeBinding } from "./native.js";
import { noReplaceUnavailable } from "./native-noreplace.js";
import type { NativeWriteParent } from "./pinned-write-types.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { syncFileBestEffortSync } from "./file-sync.js";

export type SidecarPublicationOptions = {
  nativeParent?: NativeWriteParent;
  assertCurrent?: () => void;
  onConflict?: (error: unknown) => void;
  prepare?: (fd: number) => void;
  requireExactIdentity?: boolean;
  onOpenFailure?: (error: unknown) => void;
};

// Final lock ownership never comes from staging cleanup or an observed PID.
class SidecarPublication {
  readonly temporaryPath: string;
  private identity?: BigIntStats;
  private temporaryIdentity?: BigIntStats;
  private publishedIdentity?: BigIntStats;
  private published = false;
  private ownedParent?: number;
  private parentIdentity: BigIntStats;
  close(): void {
    const fd = this.ownedParent;
    this.ownedParent = undefined;
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* Preserve the creation outcome. */ }
  }
  constructor(readonly targetPath: string, readonly raw: string, readonly options: SidecarPublicationOptions) {
    if (!options.nativeParent) {
      const binding = getNativeBinding();
      if (binding && (binding.renameNoReplace || binding.linkBeneath)) {
        this.ownedParent = fs.openSync(path.dirname(targetPath), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
        options = { ...options, nativeParent: { fd: this.ownedParent, binding } };
      }
    }
    this.options = options;
    try {
      this.parentIdentity = options.nativeParent
        ? fs.fstatSync(options.nativeParent.fd, { bigint: true })
        : fs.statSync(path.dirname(targetPath), { bigint: true });
      this.temporaryPath = sidecarStagingPath(targetPath);
      cleanupSidecarStages(targetPath, () => this.assertParent(), options.nativeParent);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  assertParent(): void {
    this.options.assertCurrent?.();
    const parent = fs.statSync(path.dirname(this.targetPath), { bigint: true });
    if (!parent.isDirectory() || !sameFileIdentityForCleanup(parent, this.parentIdentity)) {
      throw new FsSafeError("path-mismatch", "sidecar publication parent changed");
    }
  }
  remember(fd: number): void {
    this.identity = fs.fstatSync(fd, { bigint: true });
    if (this.options.requireExactIdentity && (!this.identity.isFile() || this.identity.nlink !== 1n ||
      !sameFileIdentityForCleanup(this.identity, this.identity))) {
      throw new FsSafeError("path-mismatch", "sidecar stage has no exact creation identity");
    }
  }
  private assertNamed(name: string, fd: number, links: bigint): void {
    this.assertParent();
    const opened = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(name, { bigint: true });
    const previous = name === this.temporaryPath ? this.temporaryIdentity : this.publishedIdentity;
    const pathStable = !previous || sameFileIdentityForCleanup(named, previous);
    const heldMatches = this.identity && (this.options.requireExactIdentity
      ? sameFileIdentityForCleanup(opened, this.identity) : sameFileIdentity(opened, this.identity));
    let namedMatches = this.identity && sameFileIdentityForCleanup(named, this.identity);
    if (!namedMatches && !this.options.requireExactIdentity && named.isFile() && !named.isSymbolicLink()) {
      // Raw lock ownership already tolerates descriptor/path identity drift:
      // verify the complete in-memory owner token through a stable pathname.
      const snapshot = readSidecarLockRawSnapshotSync(name, { allowDescriptorIdentityDrift: true });
      namedMatches = !!snapshot?.stat && snapshot.raw === this.raw && sameFileIdentityForCleanup(named, snapshot.stat);
    }
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || !heldMatches ||
      !namedMatches || !pathStable || opened.nlink !== links || named.nlink !== links) {
      throw new FsSafeError("path-mismatch", "sidecar publication identity changed");
    }
    if (name === this.temporaryPath) this.temporaryIdentity ??= named;
    else this.publishedIdentity ??= named;
  }

  publish(fd: number): boolean {
    this.assertNamed(this.temporaryPath, fd, 1n);
    getFsSafeTestHooks()?.beforeSidecarLockPublish?.(this.targetPath, this.temporaryPath);
    this.assertNamed(this.temporaryPath, fd, 1n);
    const native = this.options.nativeParent;
    const source = path.basename(this.temporaryPath), target = path.basename(this.targetPath);
    if (native?.binding.renameNoReplace) {
      try {
        native.binding.renameNoReplace(native.fd, source, native.fd, target);
        this.published = true;
      } catch (error) {
        if (!noReplaceUnavailable(error, "sidecar publication", true)) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") this.options.onConflict?.(error);
          throw error;
        }
      }
    }
    if (!this.published) {
      try {
        if (native?.binding.linkBeneath) native.binding.linkBeneath(native.fd, source, native.fd, target);
        else fs.linkSync(this.temporaryPath, this.targetPath);
        this.published = true;
      } catch (error) {
        if (isHardlinkFallbackError(error)) return false;
        if ((error as NodeJS.ErrnoException).code === "EEXIST") this.options.onConflict?.(error);
        throw error;
      }
      this.assertNamed(this.targetPath, fd, 2n);
      this.assertNamed(this.temporaryPath, fd, 2n);
      this.removeTemporary(fd);
    }
    this.assertNamed(this.targetPath, fd, 1n);
    if (native) syncFileBestEffortSync(native.fd);
    else if (process.platform !== "win32") {
      const parent = fs.openSync(path.dirname(this.targetPath), fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
      try { this.options.assertCurrent?.(); syncFileBestEffortSync(parent); }
      finally { fs.closeSync(parent); }
    }
    this.assertNamed(this.targetPath, fd, 1n);
    return true;
  }
  cleanup(fd: number): void {
    if (this.published) this.removeName(this.targetPath, fd);
    this.removeTemporary(fd);
  }
  removeTemporary(fd: number): void {
    this.removeName(this.temporaryPath, fd);
  }
  private removeName(pathname: string, fd: number): void {
    if (!this.identity) return;
    this.assertParent();
    const current = fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
    if (!current) return;
    const expected = pathname === this.temporaryPath ? this.temporaryIdentity ?? this.identity
      : this.publishedIdentity ?? this.identity;
    if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentityForCleanup(current, expected)) {
      return;
    }
    const native = this.options.nativeParent;
    if (native?.binding.removeStagedFile) {
      const removed = native.binding.removeStagedFile(native.fd, path.basename(pathname), fd);
      if (removed !== "removed" && removed !== "name-absent") {
        throw new FsSafeError("path-mismatch", "sidecar stage cleanup lost identity");
      }
    } else fs.unlinkSync(pathname);
  }
}

export function createSidecarFileSync(
  targetPath: string, raw: string,
  open: (pathname: string) => number,
  options: SidecarPublicationOptions = {},
): { fd: number; complete: boolean } {
  const publication = new SidecarPublication(targetPath, raw, options);
  let fd: number | undefined;
  try {
    publication.assertParent();
    fd = open(publication.temporaryPath);
    publication.remember(fd);
    options.prepare?.(fd);
    fs.writeFileSync(fd, raw, "utf8");
    fs.fsyncSync(fd);
    if (publication.publish(fd)) return { fd, complete: true };
    publication.removeTemporary(fd);
    const completed = fd;
    fd = undefined;
    fs.closeSync(completed);
  } catch (error) {
    if (fd !== undefined) {
      try {
        try { publication.cleanup(fd); } finally { fs.closeSync(fd); }
      } catch (cleanupError) {
        throw createSuppressedError(error, cleanupError, "sidecar preparation and cleanup both failed");
      }
    }
    throw error;
  } finally { publication.close(); }
  // Preserve exclusive-create compatibility on mounts with neither primitive.
  try { assertExclusiveCreateLeaf(targetPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") options.onConflict?.(error);
    throw error;
  }
  return { fd: open(targetPath), complete: false };
}

export async function createSidecarFile<T extends { fd: number; close(): Promise<void>; writeFile(data: string, encoding: BufferEncoding): Promise<void> }>(
  targetPath: string, raw: string, open: (pathname: string) => Promise<T>,
  options: SidecarPublicationOptions = {},
): Promise<{ handle: T; complete: boolean }> {
  const publication = new SidecarPublication(targetPath, raw, options);
  let handle: T | undefined;
  try {
    publication.assertParent();
    handle = await open(publication.temporaryPath);
    publication.remember(handle.fd);
    options.prepare?.(handle.fd);
    await handle.writeFile(raw, "utf8");
    fs.fsyncSync(handle.fd);
    if (publication.publish(handle.fd)) return { handle, complete: true };
    publication.removeTemporary(handle.fd);
    const completed = handle;
    handle = undefined;
    await completed.close();
  } catch (error) {
    if (handle) {
      try {
        try { publication.cleanup(handle.fd); } finally { await handle.close(); }
      } catch (cleanupError) {
        throw createSuppressedError(cleanupError, error, "sidecar preparation and cleanup both failed");
      }
    }
    throw error;
  } finally { publication.close(); }
  try { assertExclusiveCreateLeaf(targetPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") options.onConflict?.(error);
    throw error;
  }
  try { return { handle: await open(targetPath), complete: false }; }
  catch (error) { options.onOpenFailure?.(error); throw error; }
}
