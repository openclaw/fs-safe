import fsSync from "node:fs";
import { hasErrorCode } from "./file-cleanup.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { sleep, sleepSync } from "./timing.js";

// 9P is the only filesystem class with measured evidence for both behaviors
// this fallback relies on: a renamed name stays hidden behind any open
// descriptor, and recreate-after-close yields a new identity (NTFS MFT record
// plus sequence number), so identity re-verification still rejects a swapped
// file. Everything else keeps the strict pinned contract and fails closed.
const ADMITTED_UNPINNED_STATFS_TYPES: readonly bigint[] = [0x01021997n];

export function admitsUnpinnedRenameRecovery(directoryPath: string): boolean {
  const hook = getFsSafeTestHooks()?.admitUnpinnedRenameRecovery;
  if (hook) return hook(directoryPath);
  try {
    return ADMITTED_UNPINNED_STATFS_TYPES.includes(
      fsSync.statfsSync(directoryPath, { bigint: true }).type,
    );
  } catch {
    return false;
  }
}

/** Native publication paths hold a parent descriptor instead of a path. */
export function admitsUnpinnedRenameRecoveryAtFd(parentFd: number): boolean {
  if (process.platform !== "linux") return false;
  const procPath = `/proc/self/fd/${parentFd}`;
  const hook = getFsSafeTestHooks()?.admitUnpinnedRenameRecovery;
  if (hook) return hook(procPath);
  try {
    return ADMITTED_UNPINNED_STATFS_TYPES.includes(fsSync.statfsSync(procPath, { bigint: true }).type);
  } catch {
    return false;
  }
}

/**
 * DrvFS bind mounts keep a renamed name invisible while ANY descriptor to the
 * renamed inode is open, including a metadata pin (openclaw/openclaw#193262),
 * so a pin cannot bridge the recovery window there. Ordinary filesystems need
 * the opposite: the pin retains the inode across the writer close so identity
 * verification can still detect a swapped or deleted file, which silently
 * recycles device/inode pairs there.
 *
 * Recovery therefore keeps the pin through settlement by default. The
 * close-everything fallback runs only when the mount still hides the name
 * behind the pin AND the filesystem is admitted by
 * `admitsUnpinnedRenameRecovery`; `reopen` must re-verify the published
 * identity so a mismatch still fails closed. `retain` runs settlement checks
 * while the pin (or the caller's recovered handle) still guards the name.
 */
export async function recoverAfterHiddenRename<T>(params: {
  closeWriter: () => Promise<void>;
  reopen: () => Promise<T>;
  openPin?: () => number;
  admitUnpinned?: () => boolean;
  retain?: (recovered: T) => Promise<void>;
  attempts?: number;
  backoffMs?: number;
}): Promise<T> {
  let pin: number | undefined;
  try {
    if (params.openPin) pin = params.openPin();
    await params.closeWriter();
    let recovered: T;
    try {
      recovered = await params.reopen();
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") || !params.admitUnpinned?.()) throw error;
      if (pin !== undefined) {
        closePublicationPin(pin);
        pin = undefined;
      }
      recovered = await reopenAdmitted(params);
    }
    if (params.retain) await params.retain(recovered);
    return recovered;
  } finally {
    if (pin !== undefined) closePublicationPin(pin);
  }
}

/** Synchronous counterpart for native and other sync publication paths. */
export function recoverAfterHiddenRenameSync<T>(params: {
  closeWriter: () => void;
  reopen: () => T;
  openPin?: () => number;
  admitUnpinned?: () => boolean;
  retain?: (recovered: T) => void;
  attempts?: number;
  backoffMs?: number;
}): T {
  let pin: number | undefined;
  try {
    if (params.openPin) pin = params.openPin();
    params.closeWriter();
    let recovered: T;
    try {
      recovered = params.reopen();
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") || !params.admitUnpinned?.()) throw error;
      if (pin !== undefined) {
        closePublicationPin(pin);
        pin = undefined;
      }
      recovered = reopenAdmittedSync(params);
    }
    if (params.retain) params.retain(recovered);
    return recovered;
  } finally {
    if (pin !== undefined) closePublicationPin(pin);
  }
}

async function reopenAdmitted<T>(params: {
  reopen: () => Promise<T>;
  attempts?: number;
  backoffMs?: number;
}): Promise<T> {
  const maxAttempts = params.attempts ?? 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await params.reopen();
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") || attempt >= maxAttempts) throw error;
      await sleep(params.backoffMs ?? 20);
    }
  }
}

function reopenAdmittedSync<T>(params: {
  reopen: () => T;
  attempts?: number;
  backoffMs?: number;
}): T {
  const maxAttempts = params.attempts ?? 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return params.reopen();
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") || attempt >= maxAttempts) throw error;
      sleepSync(params.backoffMs ?? 20);
    }
  }
}

function closePublicationPin(pin: number): void {
  try {
    fsSync.closeSync(pin);
  } catch {
    // A pin we opened stays best-effort on cleanup; recovery must continue.
  }
}
