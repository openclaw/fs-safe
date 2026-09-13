import { assertAbsolutePathInput } from "./absolute-path.js";
import { requireNativeBinding } from "./native.js";

export type CloneFileMetadata = {
  dev: number;
  type: number;
  mtimeSec: number;
  mtimeNs: number;
  ctimeSec: number;
  ctimeNs: number;
  uid: number;
  gid: number;
  mode: number;
  ino: bigint;
  size: bigint;
  cloneId: bigint;
};

/** Batched APFS metadata snapshots; absent on unsupported files or filesystems.
 * These are point-in-time facts, not authorization or a guarantee against later edits.
 */
export async function readCloneFileMetadata(
  files: readonly string[],
): Promise<(CloneFileMetadata | undefined)[]> {
  const paths = files.map(assertAbsolutePathInput);
  const results = await requireNativeBinding().readCloneFileMetadata(paths);
  return results.map((result) => {
    if (
      !result ||
      result.length !== 100 ||
      result.readUInt32LE(0) !== 100 ||
      result.readUInt32LE(4) !== 0x82038c0a ||
      result.readUInt32LE(16) !== 0x200 ||
      result.readUInt32LE(20) !== 0x100
    )
      return undefined;
    return {
      dev: result.readUInt32LE(24),
      type: result.readUInt32LE(28),
      mtimeSec: Number(result.readBigInt64LE(32)),
      mtimeNs: Number(result.readBigInt64LE(40)),
      ctimeSec: Number(result.readBigInt64LE(48)),
      ctimeNs: Number(result.readBigInt64LE(56)),
      uid: result.readUInt32LE(64),
      gid: result.readUInt32LE(68),
      mode: result.readUInt32LE(72),
      ino: result.readBigUInt64LE(76),
      size: result.readBigUInt64LE(84),
      cloneId: result.readBigUInt64LE(92),
    };
  });
}
