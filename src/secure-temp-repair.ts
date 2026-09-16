import fs, { type BigIntStats } from "node:fs";

type ExactDirectoryStat = Pick<BigIntStats, "dev" | "ino" | "uid" | "mode" | "isDirectory" | "isSymbolicLink">;

/** Complete, synchronous descriptor authority for secure-temp admission and repair. */
export type SecureTempRootDescriptorAdapter = {
  lstatSync(path: string, options: { bigint: true }): ExactDirectoryStat;
  fstatSync(fd: number, options: { bigint: true }): ExactDirectoryStat;
  openSync(path: string, flags: number): number;
  fchmodSync(fd: number, mode: number): void;
  closeSync(fd: number): void;
  constants: { O_RDONLY: number; O_DIRECTORY: number; O_NOFOLLOW: number; O_NONBLOCK: number };
};

export type SecureTempDirectoryReceipt = Readonly<{ dev: bigint; ino: bigint; uid: bigint; mode: bigint }>;
export type SecureTempRepairAdapter = Omit<SecureTempRootDescriptorAdapter, "constants"> & { flags: number };

export function captureSecureTempRepairAdapter(
  supplied: SecureTempRootDescriptorAdapter | undefined,
  hasLegacyFsHooks: boolean,
): SecureTempRepairAdapter | undefined {
  if (supplied === undefined && hasLegacyFsHooks) return undefined;
  if (supplied !== undefined && (supplied === null || (typeof supplied !== "object" && typeof supplied !== "function"))) return undefined;
  const source = supplied === undefined ? fs : supplied;
  const { lstatSync, fstatSync, openSync, fchmodSync, closeSync, constants } = source;
  const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants ?? {};
  if ([lstatSync, fstatSync, openSync, fchmodSync, closeSync].some((fn) => typeof fn !== "function") ||
      O_RDONLY !== 0 || [O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK].some((flag) =>
        !Number.isSafeInteger(flag) || flag <= 0 || flag > 0x7fff_ffff) ||
      (O_DIRECTORY & O_NOFOLLOW) !== 0 || (O_DIRECTORY & O_NONBLOCK) !== 0 || (O_NOFOLLOW & O_NONBLOCK) !== 0) {
    return undefined;
  }
  return { lstatSync, fstatSync, openSync, fchmodSync, closeSync, flags: O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK };
}

export function secureTempDirectoryReceipt(stat: ExactDirectoryStat, uid: number): SecureTempDirectoryReceipt {
  const { dev, ino, uid: owner, mode } = stat;
  if (typeof dev !== "bigint" || dev < 0n || typeof ino !== "bigint" || ino <= 0n ||
      typeof owner !== "bigint" || owner !== BigInt(uid) || typeof mode !== "bigint" ||
      mode < 0n || mode > 0xffff_ffffn || (mode & 0o170000n) !== 0o040000n ||
      stat.isDirectory() !== true || stat.isSymbolicLink() !== false) {
    throw new Error("Secure temp directory identity, owner, or type could not be verified.");
  }
  return { dev, ino, uid: owner, mode };
}

function assertSameDirectory(stat: ExactDirectoryStat, expected: SecureTempDirectoryReceipt, uid: number) {
  const observed = secureTempDirectoryReceipt(stat, uid);
  if (observed.dev !== expected.dev || observed.ino !== expected.ino || observed.uid !== expected.uid) {
    throw new Error("Secure temp directory changed during repair.");
  }
  return observed;
}

function mayHaveConcurrentRepair(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = error.code;
  return code === "EPERM" || code === "EACCES" || code === "ENOENT";
}

/** No pathname chmod, search-only descriptors, procfs, or reopening fallback. */
export function repairSecureTempDirectory(
  candidate: string,
  expected: SecureTempDirectoryReceipt,
  uid: number,
  adapter: SecureTempRepairAdapter,
  access: () => void,
  repaired: () => void,
  finalize = false,
): void {
  assertSameDirectory(adapter.lstatSync(candidate, { bigint: true }), expected, uid);
  const fd = adapter.openSync(candidate, adapter.flags);
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("Secure temp directory descriptor is invalid.");
  const errors: unknown[] = [];
  try {
    const inspect = () => {
      const opened = assertSameDirectory(adapter.fstatSync(fd, { bigint: true }), expected, uid);
      const named = assertSameDirectory(adapter.lstatSync(candidate, { bigint: true }), expected, uid);
      return { opened, named };
    };
    const verify = (requireExactMode: boolean) => {
      const check = () => {
        const { opened, named } = inspect();
        for (const stat of [opened, named]) {
          if ((stat.mode & 0o022n) !== 0n || (requireExactMode && (stat.mode & 0o7777n) !== 0o700n)) {
            throw new Error("Secure temp directory permissions remain unsafe.");
          }
        }
      };
      check();
      access();
      check();
    };
    const { opened } = inspect();
    const needsChmod = finalize ? (opened.mode & 0o7777n) !== 0o700n :
      (opened.mode & 0o022n) !== 0n || (opened.mode & 0o700n) !== 0o700n;
    let chmodError: unknown;
    let chmodFailed = false;
    if (needsChmod) {
      try {
        adapter.fchmodSync(fd, 0o700);
      } catch (error) {
        if (!mayHaveConcurrentRepair(error)) throw error;
        chmodFailed = true;
        chmodError = error;
      }
      if (!chmodFailed) repaired();
    }
    try {
      verify(finalize || (needsChmod && !chmodFailed));
    } catch (error) {
      if (chmodFailed) throw new AggregateError([chmodError, error], "Secure temp directory chmod and verification failed.");
      throw error;
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    adapter.closeSync(fd);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 1) throw new AggregateError(errors, "Secure temp directory repair and close failed.");
  if (errors.length === 1) throw errors[0];
}
