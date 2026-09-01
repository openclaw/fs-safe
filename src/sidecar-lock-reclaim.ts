import { randomBytes } from "node:crypto";
import fsSync, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileDescriptorBoundedSync, readFileHandleBounded } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import type { Root } from "./root-impl.js";
import { openSidecarRoot } from "./sidecar-lock-root.js";
import { getFsSafeTestHooks } from "./test-hooks.js";

const MAX_LOCK_PAYLOAD_BYTES = 1024 * 1024;

const SIDECAR_LOCK_OWNERSHIP_TOKEN_BYTES = 16;
const SIDECAR_LOCK_OWNERSHIP_TOKEN_BITS = SIDECAR_LOCK_OWNERSHIP_TOKEN_BYTES * 8;
const SIDECAR_LOCK_OWNERSHIP_TOKEN_PREFIX = "\t".repeat(8);
const SIDECAR_LOCK_OWNERSHIP_TOKEN_PATTERN = new RegExp(
  `\\n(${SIDECAR_LOCK_OWNERSHIP_TOKEN_PREFIX}[ \\t]{${SIDECAR_LOCK_OWNERSHIP_TOKEN_BITS}})\\n$`,
);

export type SidecarLockStaleSnapshot = {
  lockPath: string;
  normalizedTargetPath: string;
  raw: string;
  payload: unknown;
};

export type SidecarLockSnapshot = {
  raw?: string;
  payload: unknown;
  stat?: Stats;
  ownershipToken?: string;
};

type SidecarLockRawSnapshot = Omit<SidecarLockSnapshot, "payload"> & { raw: string };

export function parseSidecarLockSnapshot(
  snapshot: SidecarLockRawSnapshot | null,
  parser?: (raw: string) => unknown,
): SidecarLockSnapshot | null {
  return snapshot && { ...snapshot, payload: parseSidecarLockPayload(snapshot.raw, parser) };
}

function createSidecarLockOwnershipToken(): string {
  let token = SIDECAR_LOCK_OWNERSHIP_TOKEN_PREFIX;
  for (const byte of randomBytes(SIDECAR_LOCK_OWNERSHIP_TOKEN_BYTES)) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      token += byte & (1 << bit) ? "\t" : " ";
    }
  }
  return token;
}

export function readSidecarLockOwnershipToken(raw: string): string | undefined {
  return SIDECAR_LOCK_OWNERSHIP_TOKEN_PATTERN.exec(raw)?.[1];
}

export function serializeSidecarLockPayload(payload: Record<string, unknown>): {
  raw: string;
  ownershipToken: string;
} {
  const ownershipToken = createSidecarLockOwnershipToken();
  return {
    raw: `${JSON.stringify(payload, null, 2)}\n${ownershipToken}\n`,
    ownershipToken,
  };
}

export function relativeSidecarLockPath(lockRoot: Root, lockPath: string): string {
  const resolved = path.resolve(lockPath);
  const lexicalRelative = path.relative(lockRoot.rootDir, resolved);
  const relative =
    lexicalRelative !== ".." &&
    !lexicalRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(lexicalRelative)
      ? lexicalRelative
      : path.relative(lockRoot.rootReal, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new FsSafeError("outside-workspace", "sidecar lock path is outside lockRoot");
  }
  return relative.split(path.sep).join(path.posix.sep);
}

export function parseSidecarLockPayload(
  raw: string,
  parser?: (raw: string) => unknown,
): unknown {
  if (parser) {
    return parser(raw);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function missingSnapshotPath(error: unknown): null {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  throw error;
}

export async function readSidecarLockSnapshot(
  lockPath: string,
  options: Parameters<typeof readSidecarLockRawSnapshot>[1] & { parsePayload?: (raw: string) => unknown } = {},
): Promise<SidecarLockSnapshot | null> {
  return parseSidecarLockSnapshot(await readSidecarLockRawSnapshot(lockPath, options), options.parsePayload);
}

export async function readSidecarLockRawSnapshot(
  lockPath: string,
  options: {
    lockRoot?: Root;
    rejectNonFile?: boolean;
    allowDescriptorIdentityDrift?: boolean;
    // Acquisition alone may discard a proven-unlinked observation, never delete from it.
    discardUnlinked?: boolean;
    onOpenFailure?: (error: unknown) => void;
  } = {},
): Promise<SidecarLockRawSnapshot | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (options.lockRoot) {
      const lockRoot = options.lockRoot;
      const relative = relativeSidecarLockPath(lockRoot, lockPath);
      const opened = await openSidecarRoot(lockRoot, relative, options.discardUnlinked, options.onOpenFailure);
      if (!opened) return null;
      try {
        const raw = (await readFileHandleBounded(opened.handle, MAX_LOCK_PAYLOAD_BYTES)).toString("utf8");
        return {
          raw,
          stat: opened.stat,
        };
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    }
    const before = await fs.lstat(lockPath).catch(missingSnapshotPath);
    if (!before) return null;
    if (!before.isFile() || before.isSymbolicLink()) {
      if (options.rejectNonFile) {
        throw new FsSafeError("not-file", `sidecar lock is not a regular file: ${lockPath}`);
      }
      return null;
    }
    await getFsSafeTestHooks()?.beforeSidecarLockSnapshotOpen?.(lockPath);
    const noFollow =
      process.platform !== "win32" && typeof fsSync.constants.O_NOFOLLOW === "number"
        ? fsSync.constants.O_NOFOLLOW
        : 0;
    try {
      handle = await fs.open(
        lockPath,
        fsSync.constants.O_RDONLY |
          noFollow |
          (typeof fsSync.constants.O_NONBLOCK === "number" ? fsSync.constants.O_NONBLOCK : 0),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (options.rejectNonFile && (error as NodeJS.ErrnoException).code === "ELOOP") {
        throw new FsSafeError("not-file", `sidecar lock is not a regular file: ${lockPath}`, {
          cause: error,
        });
      }
      options.onOpenFailure?.(error);
      throw error;
    }
    const opened = await handle.stat();
    if (!opened.isFile()) {
      if (options.rejectNonFile) {
        throw new FsSafeError("not-file", `sidecar lock is not a regular file: ${lockPath}`);
      }
      return null;
    }
    if (!options.allowDescriptorIdentityDrift && !sameFileIdentity(before, opened)) return null;
    const raw = (await readFileHandleBounded(handle, MAX_LOCK_PAYLOAD_BYTES)).toString("utf8");
    const after = await fs.lstat(lockPath).catch(missingSnapshotPath);
    if (!after || !after.isFile() || !sameFileIdentity(before, after)) return null;
    return { raw, stat: after };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function lstatSidecarLockSync(lockPath: string): Stats | null {
  try {
    return fsSync.lstatSync(lockPath);
  } catch (error) {
    return missingSnapshotPath(error);
  }
}

export function readSidecarLockSnapshotSync(
  lockPath: string,
  parsePayload?: (raw: string) => unknown,
  options: Parameters<typeof readSidecarLockRawSnapshotSync>[1] = {},
): SidecarLockSnapshot | null {
  return parseSidecarLockSnapshot(readSidecarLockRawSnapshotSync(lockPath, options), parsePayload);
}

export function readSidecarLockRawSnapshotSync(
  lockPath: string,
  options: { rejectNonFile?: boolean; onOpenFailure?: (error: unknown) => void } = {},
): SidecarLockRawSnapshot | null {
  let fd: number | undefined;
  try {
    const before = lstatSidecarLockSync(lockPath);
    if (!before) return null;
    if (!before.isFile() || before.isSymbolicLink()) {
      if (options.rejectNonFile) {
        throw new FsSafeError("not-file", `sidecar lock is not a regular file: ${lockPath}`);
      }
      return null;
    }
    try {
      fd = fsSync.openSync(lockPath, resolveReadOpenFlags());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      options.onOpenFailure?.(error);
      throw error;
    }
    const opened = fsSync.fstatSync(fd);
    if (!opened.isFile()) {
      if (options.rejectNonFile) {
        throw new FsSafeError("not-file", `sidecar lock is not a regular file: ${lockPath}`);
      }
      return null;
    }
    const raw = readFileDescriptorBoundedSync(fd, MAX_LOCK_PAYLOAD_BYTES).toString("utf8");
    const after = lstatSidecarLockSync(lockPath);
    if (!after || !sameFileIdentity(before, opened) || !sameFileIdentity(opened, after)) return null;
    return {
      raw,
      stat: after,
      ownershipToken: readSidecarLockOwnershipToken(raw),
    };
  } finally {
    if (fd !== undefined) fsSync.closeSync(fd);
  }
}

export function removeSidecarLockIfUnchangedSync(
  lockPath: string,
  observed: SidecarLockSnapshot,
): boolean {
  const current = readSidecarLockSnapshotSync(lockPath);
  if (!current || !sidecarLockSnapshotMatches(current, observed)) return false;
  fsSync.rmSync(lockPath);
  return true;
}

export function sidecarLockSnapshotMatches(
  current: SidecarLockSnapshot,
  observed: SidecarLockSnapshot,
): boolean {
  if (observed.ownershipToken !== undefined) {
    return (
      current.stat?.isFile() === true &&
      current.raw !== undefined &&
      observed.raw !== undefined &&
      readSidecarLockOwnershipToken(current.raw) === observed.ownershipToken &&
      readSidecarLockOwnershipToken(observed.raw) === observed.ownershipToken &&
      current.raw === observed.raw
    );
  }
  if (observed.stat && current.stat && !sameFileIdentity(observed.stat, current.stat)) {
    return false;
  }
  if (observed.raw !== undefined) {
    return current.raw === observed.raw;
  }
  return observed.stat !== undefined && current.stat !== undefined;
}

export async function removeSidecarLockIfUnchanged(
  lockPath: string,
  observed: SidecarLockSnapshot | null,
  options: { lockRoot?: Root; parsePayload?: (raw: string) => unknown } = {},
): Promise<boolean> {
  const current = await readSidecarLockSnapshot(lockPath, {
    ...options,
    allowDescriptorIdentityDrift: observed?.ownershipToken !== undefined,
  });
  if (!current || !observed || !sidecarLockSnapshotMatches(current, observed)) {
    return false;
  }
  if (options.lockRoot) {
    await options.lockRoot.remove(relativeSidecarLockPath(options.lockRoot, lockPath));
  } else {
    await fs.rm(lockPath, { force: true });
  }
  return true;
}

export async function sidecarLockSnapshotStillPresent(
  lockPath: string,
  observed: SidecarLockSnapshot | null,
  options: { lockRoot?: Root; parsePayload?: (raw: string) => unknown } = {},
): Promise<boolean> {
  const current = await readSidecarLockSnapshot(lockPath, {
    ...options,
    allowDescriptorIdentityDrift: observed?.ownershipToken !== undefined,
  });
  return !!current && !!observed && sidecarLockSnapshotMatches(current, observed);
}

export async function sidecarReclaimGuardExists(pathname: string): Promise<boolean> {
  try {
    await fs.lstat(pathname);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export async function tryAcquireSidecarReclaimGuard(
  reclaimGuards: Set<string>,
  reclaimGuardPath: string,
): Promise<boolean> {
  try {
    await fs.mkdir(reclaimGuardPath);
    reclaimGuards.add(reclaimGuardPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

export async function releaseSidecarReclaimGuard(
  reclaimGuards: Set<string>,
  reclaimGuardPath: string,
): Promise<void> {
  await fs.rmdir(reclaimGuardPath);
  reclaimGuards.delete(reclaimGuardPath);
}

export async function removeStaleSidecarLockIfAllowed(params: {
  lockPath: string;
  normalizedTargetPath: string;
  snapshot: SidecarLockSnapshot;
  shouldRemoveStaleLock?: (snapshot: SidecarLockStaleSnapshot) => boolean | Promise<boolean>;
  lockRoot?: Root;
  parsePayload?: (raw: string) => unknown;
}): Promise<"removed" | "changed" | "not-approved"> {
  if (!params.shouldRemoveStaleLock || params.snapshot.raw === undefined) {
    return "not-approved";
  }
  const ioOptions = { lockRoot: params.lockRoot, parsePayload: params.parsePayload };
  if (!(await sidecarLockSnapshotStillPresent(params.lockPath, params.snapshot, ioOptions))) {
    return "changed";
  }
  if (
    !(await params.shouldRemoveStaleLock({
      lockPath: params.lockPath,
      normalizedTargetPath: params.normalizedTargetPath,
      raw: params.snapshot.raw,
      payload: params.snapshot.payload,
    }))
  ) {
    return "not-approved";
  }
  if (!(await sidecarLockSnapshotStillPresent(params.lockPath, params.snapshot, ioOptions))) {
    return "changed";
  }
  try {
    if (params.lockRoot) {
      await params.lockRoot.remove(relativeSidecarLockPath(params.lockRoot, params.lockPath));
    } else {
      await fs.rm(params.lockPath);
    }
    return "removed";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "changed";
    }
    throw err;
  }
}
