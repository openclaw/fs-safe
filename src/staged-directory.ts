import fs from "node:fs";
import path from "node:path";
import type { DirectoryReceipt } from "./directory-durability.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import type { StagedFileReceipt } from "./staged-file-types.js";

type DirectorySnapshot = StagedFileReceipt["directory"];

export function exactIdentityMatches(
  expected: FileIdentityStat,
  actual: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  return (["dev", "ino"] as const).every((key) => {
    const value = expected[key];
    return (typeof value === "bigint" || Number.isSafeInteger(value)) && BigInt(value) === actual[key];
  });
}

export function describeStagedDirectory(fd: number, pathname: string): DirectorySnapshot {
  const identity = fs.fstatSync(fd, { bigint: true });
  if (!identity.isDirectory()) {
    throw new FsSafeError("not-file", "staging parent must be a directory");
  }
  const receipt = Object.freeze({
    path: path.resolve(pathname),
    realPath: fs.realpathSync(pathname),
    identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
  });
  assertStagedDirectoryCurrent(receipt);
  return receipt;
}

export function assertStagedDirectoryCurrent(receipt: DirectorySnapshot): void {
  const current = fs.lstatSync(receipt.path, { bigint: true });
  if (
    !current.isDirectory() || !exactIdentityMatches(receipt.identity, current) ||
    fs.realpathSync(receipt.path) !== receipt.realPath
  ) {
    throw new FsSafeError("path-mismatch", "staging directory pathname changed");
  }
}

export function openStagedDirectory(directory: string | DirectoryReceipt): {
  fd: number;
  receipt: DirectorySnapshot;
} {
  // Copy supplied facts before any asynchronous work; receipts are not authority.
  const pathname = path.resolve(typeof directory === "string" ? directory : directory.path);
  const expected = typeof directory === "string" ? undefined : {
    realPath: directory.realPath, dev: directory.identity.dev, ino: directory.identity.ino,
  };
  const before = fs.lstatSync(pathname, { bigint: true });
  if (!before.isDirectory()) {
    throw new FsSafeError("not-file", "staging parent must be a real directory");
  }
  if (expected && (!exactIdentityMatches(expected, before) || fs.realpathSync(pathname) !== expected.realPath)) {
    throw new FsSafeError("path-mismatch", "stale staging directory receipt");
  }
  const fd = fs.openSync(
    pathname,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const receipt = describeStagedDirectory(fd, pathname);
    if (!exactIdentityMatches(before, receipt.identity)) {
      throw new FsSafeError("path-mismatch", "staging directory changed while opening");
    }
    return { fd, receipt };
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch (closeError) {
      throw new AggregateError([error, closeError], "staging directory admission and close failed");
    }
    throw error;
  }
}
