import path from "node:path";
import { FsSafeError } from "./errors.js";
import type { NativeBinding } from "./native-binding.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import type { MutationDirectoryObserver } from "./pinned-mutation-observation.js";

export class NativePolicyDirectoryMismatch extends FsSafeError {
  constructor(cause?: Error) {
    super("path-mismatch", "staging directory pathname changed", { cause });
  }
}

export type NativePolicyDirectoryObserver = MutationDirectoryObserver & { dispose(): void };

/** Fresh name/metadata/canonical facts from a caller-owned POSIX descriptor. */
export function nativePolicyDirectoryObserver(
  binding: NativeBinding | undefined,
  fd: number,
  pathname: string,
): NativePolicyDirectoryObserver | undefined {
  if (!binding || process.platform === "win32" || process.versions.bun) return undefined;
  const observe = binding.observeDirectoryFd;
  if (typeof observe !== "function") return undefined;
  const mode = getFsSafeNativeConfig().mode;
  let disposed = false;
  const inspect: MutationDirectoryObserver = () => {
    if (disposed) throw new NativePolicyDirectoryMismatch();
    if (getFsSafeNativeConfig().mode !== mode) return undefined;
    let observed;
    try {
      observed = observe.call(binding, fd, pathname);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "OBSERVATION_UNAVAILABLE") return undefined;
      if ((error as NodeJS.ErrnoException)?.code === "OBSERVATION_REDIRECTED") {
        // A contained redirect requires ordinary selected-object admission;
        // it has not yet supplied inconsistent descriptor/name evidence.
        throw new FsSafeError("path-mismatch", "staging directory pathname redirected");
      }
      if ((error as NodeJS.ErrnoException)?.code === "path-mismatch") {
        throw new NativePolicyDirectoryMismatch(error instanceof Error ? error : undefined);
      }
      throw error;
    }
    if (getFsSafeNativeConfig().mode !== mode) return undefined;
    if (!observed || typeof observed.dev !== "bigint" || observed.dev < 0n || observed.dev > 0xffff_ffff_ffff_ffffn ||
      typeof observed.ino !== "bigint" || observed.ino < 0n || observed.ino > 0xffff_ffff_ffff_ffffn ||
      typeof observed.mode !== "bigint" || observed.mode < 0n || observed.mode > 0xffff_ffffn ||
      typeof observed.nlink !== "bigint" || observed.nlink < 0n || observed.nlink > 0xffff_ffff_ffff_ffffn ||
      typeof observed.realPath !== "string" || observed.realPath.includes("\0") ||
      !path.isAbsolute(observed.realPath)) return undefined;
    if ((observed.mode & 0o170000n) !== 0o040000n || observed.nlink === 0n ||
      observed.realPath !== pathname) {
      throw new NativePolicyDirectoryMismatch();
    }
    return Object.freeze({
      canonicalPath: observed.realPath,
      identity: Object.freeze({
        dev: observed.dev, ino: observed.ino, mode: observed.mode, nlink: observed.nlink,
      }),
    });
  };
  return Object.assign(inspect, { dispose() { disposed = true; } });
}
