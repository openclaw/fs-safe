import fs, { type BigIntStats } from "node:fs";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { isFsSafeNativeRequired } from "./native-config.js";

export type CopyMetadata = Readonly<{
  atimeNs: bigint;
  mtimeNs: bigint;
  restoreNative?: (fd: number) => void;
}>;

export function timestampSeconds(nanoseconds: bigint): string {
  // Numeric strings retain fractional and pre-epoch times in Node's utimes API.
  return String(Number(nanoseconds / 1_000_000_000n) + Number(nanoseconds % 1_000_000_000n) / 1e9);
}

export function captureCopyMetadata(fd: number, stat: BigIntStats): CopyMetadata {
  let restoreNative: CopyMetadata["restoreNative"];
  const native = getNativeBinding();
  if (process.platform === "win32") {
    if (native?.readCopyMetadata && native.restoreCopyMetadata) {
      const snapshot = native.readCopyMetadata(fd);
      const restore = native.restoreCopyMetadata.bind(native);
      restoreNative = target => restore(target, snapshot);
    } else if (isFsSafeNativeRequired()) {
      throw new FsSafeError("helper-unavailable", "native Windows copy metadata preservation is unavailable");
    }
  } else if (native?.restoreCopyFileTimes) {
    const restore = native.restoreCopyFileTimes.bind(native);
    const { atimeNs, mtimeNs } = stat;
    restoreNative = target => restore(target, atimeNs, mtimeNs);
  } else if (isFsSafeNativeRequired()) {
    throw new FsSafeError("helper-unavailable", "native copy timestamp preservation is unavailable");
  }
  return Object.freeze({ atimeNs: stat.atimeNs, mtimeNs: stat.mtimeNs, restoreNative });
}

export function restoreCopyMetadata(fd: number, metadata: CopyMetadata | undefined): void {
  if (!metadata) return;
  if (metadata.restoreNative) metadata.restoreNative(fd);
  else fs.futimesSync(fd, timestampSeconds(metadata.atimeNs), timestampSeconds(metadata.mtimeNs));
}
