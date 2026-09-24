import type { BigIntStats, Stats } from "node:fs";
import fsSync from "node:fs";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { realpathSync } from "./realpath.js";
import { directoryComponentNotDirectoryError, errorCauseOptions } from "./root-errors.js";

type ExactDirectoryIdentity = Readonly<Pick<BigIntStats, "dev" | "ino">>;
const MAX_SAFE_DIRECTORY_IDENTITY = BigInt(Number.MAX_SAFE_INTEGER);

export type RemovalDirectoryAssertion = ExactDirectoryIdentity & Readonly<{
  path: string;
  numericDev?: number;
  numericIno?: number;
  platform: NodeJS.Platform;
  realPath?: string;
}>;

function identityMismatch(cause?: unknown): FsSafeError {
  return new FsSafeError(
    "path-mismatch",
    "removal ancestor identity changed or could not be verified",
    errorCauseOptions(cause),
  );
}

function safeIdentityNumber(value: bigint): number | undefined {
  if (value < 0n || value > MAX_SAFE_DIRECTORY_IDENTITY) return undefined;
  return Number(value);
}

export function createRemovalDirectoryAssertion(
  path: string,
  identity: ExactDirectoryIdentity,
  realPath?: string,
  platform: NodeJS.Platform = process.platform,
): RemovalDirectoryAssertion {
  const dev = safeIdentityNumber(identity.dev);
  const ino = safeIdentityNumber(identity.ino);
  const numeric = dev !== undefined && ino !== undefined &&
    (platform !== "win32" || (dev !== 0 && ino !== 0));
  return Object.freeze({
    path,
    dev: identity.dev,
    ino: identity.ino,
    numericDev: numeric ? dev : undefined,
    numericIno: numeric ? ino : undefined,
    platform,
    realPath,
  });
}

function assertDirectoryType(stat: Pick<Stats | BigIntStats, "isDirectory" | "isSymbolicLink">): void {
  if (typeof stat?.isDirectory !== "function" || typeof stat.isSymbolicLink !== "function") {
    throw identityMismatch();
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw directoryComponentNotDirectoryError();
}

function assertExactObservation(
  stat: BigIntStats,
  expected: ExactDirectoryIdentity,
  platform: NodeJS.Platform,
): void {
  assertDirectoryType(stat);
  if (typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint") throw identityMismatch();
  if (platform === "win32" && (stat.dev === 0n || stat.ino === 0n)) throw identityMismatch();
  if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw identityMismatch();
}

function assertNumericObservation(
  assertion: RemovalDirectoryAssertion,
): void {
  const stat = fsSync.lstatSync(assertion.path);
  assertDirectoryType(stat);
  if (!Number.isSafeInteger(stat.dev) || stat.dev < 0 ||
    !Number.isSafeInteger(stat.ino) || stat.ino < 0) {
    throw identityMismatch();
  }

  let unknown = false;
  const observedDev = stat.dev;
  const expectedDev = assertion.numericDev;
  if (assertion.platform === "win32" && observedDev === 0) {
    unknown = true;
  } else if (observedDev !== expectedDev) {
    // Reject a known mismatch before considering an unknown companion field.
    throw identityMismatch();
  }
  const observedIno = stat.ino;
  const expectedIno = assertion.numericIno;
  if (assertion.platform === "win32" && observedIno === 0) {
    unknown = true;
  } else if (observedIno !== expectedIno) {
    throw identityMismatch();
  }

  if (unknown) {
    // The numeric lstat is the first observation. Permit one exact retry only,
    // retaining every known component and the original exact admission receipt.
    assertExactObservation(
      fsSync.lstatSync(assertion.path, { bigint: true }),
      assertion,
      assertion.platform,
    );
  }
}

export function assertRemovalDirectoryCurrent(assertion: RemovalDirectoryAssertion): void {
  if (assertion.numericDev !== undefined && assertion.numericIno !== undefined) {
    assertNumericObservation(assertion);
  } else {
    inspectDirectoryIdentitySync(assertion.path, assertion, undefined, assertion.platform);
  }

  if (assertion.realPath !== undefined && realpathSync.native(assertion.path) !== assertion.realPath) {
    throw identityMismatch();
  }
}
