import fsSync from "node:fs";
import path from "node:path";
import { hasErrorCode } from "./file-cleanup.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { sleep, sleepSync } from "./timing.js";

// Unpinned recovery is only sound on backends whose identities carry a
// generation: recreate-after-close must produce a device/inode pair the
// previous file could never have. That property cannot be inferred from a
// filesystem magic number, so admission runs a bounded behavioral probe
// (create/stat/unlink rounds must all produce distinct non-zero identities)
// and caches the verdict per device. Backends that recycle identities fail
// the probe and keep the strict pinned contract.
const IDENTITY_PROBE_ROUNDS = 48;
const probeResults = new Map<bigint, boolean>();

export function admitsUnpinnedRenameRecovery(directoryPath: string): boolean {
  return admitsAtPath(directoryPath);
}

/** Native publication paths hold a parent descriptor instead of a path. */
export function admitsUnpinnedRenameRecoveryAtFd(parentFd: number): boolean {
  if (process.platform !== "linux") return false;
  return admitsAtPath(`/proc/self/fd/${parentFd}`);
}

function admitsAtPath(directoryPath: string): boolean {
  const hook = getFsSafeTestHooks()?.admitUnpinnedRenameRecovery;
  if (hook) return hook(directoryPath);
  let device: bigint;
  try {
    device = fsSync.lstatSync(directoryPath, { bigint: true }).dev;
  } catch {
    return false;
  }
  const cached = probeResults.get(device);
  if (cached !== undefined) return cached;
  const admitted = probeGenerationBearingIdentities(directoryPath);
  probeResults.set(device, admitted);
  return admitted;
}

function probeGenerationBearingIdentities(directoryPath: string): boolean {
  const identities = new Set<string>();
  for (let round = 0; round < IDENTITY_PROBE_ROUNDS; round += 1) {
    const probePath = path.join(directoryPath, `.fs-safe-id-probe-${process.pid}-${round}`);
    let fd = -1;
    try {
      fd = fsSync.openSync(probePath, fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY, 0o600);
      const stat = fsSync.fstatSync(fd, { bigint: true });
      if (stat.ino === 0n) return false;
      const key = `${stat.dev}:${stat.ino}`;
      if (identities.has(key)) return false;
      identities.add(key);
    } catch {
      return false;
    } finally {
      if (fd >= 0) {
        try {
          fsSync.closeSync(fd);
        } catch {
          // Best effort; the probe file is removed below.
        }
      }
    }
    try {
      fsSync.unlinkSync(probePath);
    } catch {
      return false;
    }
  }
  return true;
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
  dispose?: (recovered: T) => Promise<void>;
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
    if (params.retain) {
      try {
        await params.retain(recovered);
      } catch (error) {
        // Settlement failed; the caller never took ownership, so release the
        // recovered resource instead of leaving it unowned.
        if (params.dispose) await params.dispose(recovered).catch(() => undefined);
        throw error;
      }
    }
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
  dispose?: (recovered: T) => void;
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
    if (params.retain) {
      try {
        params.retain(recovered);
      } catch (error) {
        if (params.dispose) {
          try {
            params.dispose(recovered);
          } catch {
            // Best effort; the settlement error takes precedence.
          }
        }
        throw error;
      }
    }
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
