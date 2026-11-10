import fs from "node:fs";
import type { NativeBinding } from "./native-binding.js";
import { nativeOpenFlags } from "./native-operations.js";
import { readFileDescriptorBoundedSync } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
import { hasErrorCode } from "./file-cleanup.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { sleep, sleepSync } from "./timing.js";
import { getNativeBinding } from "./native.js";

const non9pDevices = new Set<bigint>();

/** Other platforms keep their existing path even when the option is enabled. */
export function shouldPrepareDrvfsRecovery(enabled: boolean | undefined, dev?: bigint): boolean {
  if (enabled !== true) return false;
  // Synthetic mount evidence must not inherit observations from the real host.
  if (getFsSafeTestHooks()?.drvfsMountObservation) return true;
  if (process.platform !== "linux") return false;
  if (dev === undefined) return true;
  // Linux 9p allocates anonymous devices (major zero), never block devices.
  if (((dev >> 8n) & 0xfffn) !== 0n || ((dev >> 32n) & 0xfffff000n) !== 0n) return false;
  return !non9pDevices.has(dev);
}

/** Negative evidence only: a stale/reused device number can only disable recovery. */
export function mayPrepareDrvfsRecoveryAtFd(parentFd: number, dev: bigint): boolean {
  if (!shouldPrepareDrvfsRecovery(true, dev)) return false;
  if (getFsSafeTestHooks()?.drvfsMountObservation) return true;
  try {
    if (getNativeBinding()?.is9pFilesystem?.(parentFd) === false) {
      non9pDevices.add(dev);
      return false;
    }
  } catch { /* Unavailable evidence preserves full recovery-time verification. */ }
  return true;
}

/** No sampling or positive cache: the retained directory's exact mount owns admission. */
export function admitsDrvfsRenameRecoveryAtFd(parentFd: number): boolean {
  try {
    const hook = getFsSafeTestHooks()?.drvfsMountObservation;
    if (!hook && process.platform !== "linux") return false;
    if (!Number.isInteger(parentFd) || parentFd < 0) return false;
    const observation = hook ? hook(parentFd) : (() => {
      if (fs.statfsSync("/proc/self/fd", { bigint: true }).type !== 0x9fa0n) return undefined;
      // statfs follows this kernel-owned descriptor alias to the retained parent.
      return {
        magic: fs.statfsSync(`/proc/self/fd/${parentFd}`, { bigint: true }).type,
        fdinfo: fs.readFileSync(`/proc/self/fdinfo/${parentFd}`, "utf8"),
        mountinfo: fs.readFileSync("/proc/self/mountinfo", "utf8"),
      };
    })();
    if (!observation || observation.magic !== 0x01021997n) return false;
    const ids = [...observation.fdinfo.matchAll(/^mnt_id:\s*(\d+)\s*$/gm)];
    if (ids.length !== 1) return false;
    const entries = observation.mountinfo.split("\n").filter(line => line.split(" ")[0] === ids[0]![1]);
    if (entries.length !== 1) return false;
    const [before, after, extra] = entries[0]!.split(" - ");
    if (!before || !after || extra !== undefined || before.split(" ").length < 6) return false;
    const fields = after.split(" ");
    return fields.length === 3 && fields[0] === "9p" &&
      fields[2]!.split(",").some(option => option === "aname=drvfs" || option.startsWith("aname=drvfs;"));
  } catch {
    return false;
  }
}

/** Exact metadata is necessary but cannot exclude inode reuse after the final close. */
export function assertRecoveredPublication(actual: fs.BigIntStats, expected: fs.BigIntStats): void {
  if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1n ||
    actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size ||
    actual.mode !== expected.mode || actual.uid !== expected.uid || actual.gid !== expected.gid) {
    throw new FsSafeError("path-mismatch", "published file changed during DrvFS recovery");
  }
}

export async function recoverAfterHiddenRename<T>(params: {
  closeWriter: () => Promise<void>;
  reopen: () => Promise<T>;
  parentFd: number;
  retain?: (recovered: T) => Promise<void>;
  dispose?: (recovered: T) => Promise<void>;
}): Promise<T> {
  if (!admitsDrvfsRenameRecoveryAtFd(params.parentFd)) {
    throw new FsSafeError("path-mismatch", "hidden rename recovery requires a verified DrvFS mount");
  }
  await params.closeWriter();
  for (let attempt = 0; ; attempt++) {
    let recovered: T;
    try { recovered = await params.reopen(); }
    catch (error) {
      if (!hasErrorCode(error, "ENOENT") || attempt === 4) throw error;
      await sleep(20);
      continue;
    }
    try { await params.retain?.(recovered); }
    catch (error) { await params.dispose?.(recovered).catch(() => undefined); throw error; }
    return recovered;
  }
}

export function recoverAfterHiddenRenameSync<T>(params: {
  closeWriter: () => void;
  reopen: () => T;
  parentFd: number;
}): T {
  if (!admitsDrvfsRenameRecoveryAtFd(params.parentFd)) {
    throw new FsSafeError("path-mismatch", "hidden rename recovery requires a verified DrvFS mount");
  }
  params.closeWriter();
  for (let attempt = 0; ; attempt++) {
    try { return params.reopen(); }
    catch (error) {
      if (!hasErrorCode(error, "ENOENT") || attempt === 4) throw error;
      sleepSync(20);
    }
  }
}

export function assertRecoveredFile(fd: number, expected: fs.BigIntStats, content?: Uint8Array): void {
  assertRecoveredPublication(fs.fstatSync(fd, { bigint: true }), expected);
  if (content && !readFileDescriptorBoundedSync(fd, content.byteLength).equals(content)) {
    throw new FsSafeError("path-mismatch", "published content changed during DrvFS recovery");
  }
  assertRecoveredPublication(fs.fstatSync(fd, { bigint: true }), expected);
}

export function reopenRecoveredNativeFile(
  binding: NativeBinding, parentFd: number, basename: string, expected: fs.BigIntStats, content?: Uint8Array,
): number {
  if (!binding.openBeneath || !binding.closeOwnedFd || !binding.stagedFileMatches) {
    throw new FsSafeError("helper-unavailable", "native DrvFS recovery requires descriptor-relative verification");
  }
  const fd = binding.openBeneath(parentFd, basename, nativeOpenFlags(fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)).fd;
  try {
    assertRecoveredFile(fd, expected, content);
    if (!binding.stagedFileMatches(parentFd, basename, fd)) {
      throw new FsSafeError("path-mismatch", "published name changed during DrvFS recovery");
    }
    return fd;
  } catch (error) {
    binding.closeOwnedFd(fd);
    throw error;
  }
}
