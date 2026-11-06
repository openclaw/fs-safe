import fsSync from "node:fs";
import { hasErrorCode } from "./file-cleanup.js";
import { sleep, sleepSync } from "./timing.js";

/**
 * DrvFS bind mounts keep a renamed name invisible while ANY descriptor to the
 * renamed inode is open (openclaw/openclaw#193262), including a metadata pin.
 * Ordinary filesystems need the opposite: the pin retains the inode across
 * the writer close so identity verification can still detect a swapped or
 * deleted file, which silently recycles inode numbers there.
 *
 * Recovery therefore keeps the pin while it works and only falls back to
 * closing every descriptor when the mount still hides the name behind the
 * pin. `reopen` must verify the published identity so a swapped or deleted
 * file fails closed in both modes; the bounded retry covers directory-entry
 * lag after the final close without masking a persistent ENOENT.
 */
export async function recoverAfterHiddenRename<T>(params: {
  closeWriter: () => Promise<void>;
  reopen: () => Promise<T>;
  openPin?: () => number;
  attempts?: number;
  backoffMs?: number;
}): Promise<T> {
  let pin: number | undefined;
  if (params.openPin) {
    try {
      pin = params.openPin();
    } catch {
      pin = undefined;
    }
  }
  await params.closeWriter();
  if (pin !== undefined) {
    try {
      const recovered = await params.reopen();
      closePublicationPin(pin);
      return recovered;
    } catch (error) {
      closePublicationPin(pin);
      pin = undefined;
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
  }
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

function closePublicationPin(pin: number): void {
  try {
    fsSync.closeSync(pin);
  } catch {
    // A pin we opened stays best-effort on cleanup; recovery must continue.
  }
}

/** Synchronous counterpart for native and other sync publication paths. */
export function recoverAfterHiddenRenameSync<T>(params: {
  closeWriter: () => void;
  reopen: () => T;
  openPin?: () => number;
  attempts?: number;
  backoffMs?: number;
}): T {
  let pin: number | undefined;
  if (params.openPin) {
    try {
      pin = params.openPin();
    } catch {
      pin = undefined;
    }
  }
  params.closeWriter();
  if (pin !== undefined) {
    try {
      const recovered = params.reopen();
      closePublicationPin(pin);
      return recovered;
    } catch (error) {
      closePublicationPin(pin);
      pin = undefined;
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
  }
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
