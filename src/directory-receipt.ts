import fs, { type BigIntStats, type Stats } from "node:fs";
import type { DirectoryReceipt } from "./directory-durability.js";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import { realpathSync } from "./realpath.js";
import {
  assertNoWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

type ExactIdentity = Readonly<Pick<BigIntStats, "dev" | "ino">>;
type DirectoryAuthority = Readonly<{
  path: string;
  realPath: string;
  identity: ExactIdentity;
  stat: Stats;
}>;

// Public Stats stay numeric metadata. Only these private snapshots authorize
// later use, including when a caller mutates or copies the public receipt.
const authorities = new WeakMap<DirectoryReceipt, DirectoryAuthority>();
const identities = new WeakMap<FileIdentityStat, ExactIdentity>();

export function directoryReceiptIdentity(identity: FileIdentityStat): ExactIdentity {
  if (!identity) {
    throw new FsSafeError("path-mismatch", "directory receipt identity is missing");
  }
  const known = identities.get(identity);
  if (known) return known;
  const exact = (value: number | bigint): bigint => {
    if ((typeof value !== "bigint" && !Number.isSafeInteger(value)) ||
      (process.platform === "win32" && (value === 0 || value === 0n))) {
      throw new FsSafeError("path-mismatch", "directory receipt identity could not be verified");
    }
    return BigInt(value);
  };
  return Object.freeze({ dev: exact(identity.dev), ino: exact(identity.ino) });
}

export function directoryReceiptAuthority(receipt: DirectoryReceipt): DirectoryAuthority {
  const known = authorities.get(receipt);
  if (known) return known;
  const pathname = receipt.path;
  const realPath = receipt.realPath;
  const stat = receipt.identity;
  return Object.freeze({
    path: pathname,
    realPath,
    identity: directoryReceiptIdentity(stat),
    stat,
  });
}

function rememberReceipt(receipt: DirectoryReceipt, authority: DirectoryAuthority): DirectoryReceipt {
  authorities.set(receipt, authority);
  identities.set(receipt.identity, authority.identity);
  return receipt;
}

export function ownDirectoryReceipt(receipt: DirectoryReceipt): DirectoryReceipt {
  const authority = directoryReceiptAuthority(receipt);
  return rememberReceipt({
    path: authority.path,
    realPath: authority.realPath,
    identity: authority.stat,
  }, authority);
}

function numericDirectoryStat(exact: BigIntStats): Stats {
  // Keep metadata and authority from one observation. A second pathname stat
  // can describe a replacement even when a later fence sees the original again.
  const stat = Object.create(fs.Stats.prototype) as Stats;
  for (const field of ["dev", "mode", "nlink", "uid", "gid", "rdev", "blksize", "ino", "size", "blocks"] as const) {
    stat[field] = Number(exact[field]);
  }
  for (const field of ["atime", "mtime", "ctime", "birthtime"] as const) {
    const nanoseconds = exact[`${field}Ns`];
    const remainder = ((nanoseconds % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
    stat[`${field}Ms`] = Number((nanoseconds - remainder) / 1_000_000_000n) * 1_000 + Number(remainder) / 1_000_000;
  }
  return stat;
}

export function createDirectoryReceiptSync(
  directoryPath: string,
  label: string,
  canonicalize: (pathname: string) => string = realpathSync,
): DirectoryReceipt {
  assertNoWindowsPathAlias(directoryPath, "filesystem", `${label} path uses a Windows filesystem namespace alias`);
  const pathname = resolvePathPreservingWindowsRoot(directoryPath);
  assertNoWindowsPathAlias(pathname, "filesystem", `${label} path uses a Windows filesystem namespace alias`);
  const exact = inspectDirectoryIdentitySync(pathname);
  const operationPath = pathForWindowsFilesystem(pathname);
  const stat = numericDirectoryStat(exact);
  const realPath = canonicalize(operationPath);
  assertNoWindowsPathAlias(realPath, "filesystem", `${label} real path uses a Windows filesystem namespace alias`);
  return rememberReceipt({ path: pathname, realPath, identity: stat }, Object.freeze({
    path: pathname,
    realPath,
    identity: Object.freeze({ dev: exact.dev, ino: exact.ino }),
    stat,
  }));
}

export function assertDirectoryReceiptCurrentSync(
  receipt: DirectoryReceipt,
  label: string,
  canonicalize: (pathname: string) => string = realpathSync,
): void {
  const authority = directoryReceiptAuthority(receipt);
  assertNoWindowsPathAlias(authority.path, "filesystem", `${label} path uses a Windows filesystem namespace alias`);
  assertNoWindowsPathAlias(authority.realPath, "filesystem", `${label} real path uses a Windows filesystem namespace alias`);
  inspectDirectoryIdentitySync(authority.path, authority.identity);
  const realPath = canonicalize(pathForWindowsFilesystem(authority.path));
  assertNoWindowsPathAlias(realPath, "filesystem", `${label} real path uses a Windows filesystem namespace alias`);
  if (realPath !== authority.realPath) {
    throw new FsSafeError("path-mismatch", `${label} changed during durable directory operation: ${authority.path}`);
  }
}
