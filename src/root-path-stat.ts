import type { BigIntStats, Stats } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { fileObservation, recordFileObservationFailure } from "./file-observation.js";
import { hasNodeErrorCode, isNotFoundPathError } from "./path.js";
import {
  assertRootDirectoryObservationGuard,
  assertRootPathObservationReceiptCurrent,
  createRootDirectoryObservationGuard,
  pathStatFromStats,
} from "./root-directory-list.js";
import type { RootContext } from "./root-context.js";
import { errorCauseOptions, fileNotFoundError } from "./root-errors.js";
import type { RootPathObservationReceipt } from "./root-path.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertStatObservationSync } from "./stat-observation.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import type { PathStat } from "./types.js";

type StatLeafFailure = {
  error: unknown;
  kind: `stat-leaf-missing:${string}` | `stat-leaf-changed:${string}`;
};

function singleLinkFileIdentity(stat: Stats | BigIntStats | undefined) {
  if (!stat?.isFile() || stat.isSymbolicLink() || (stat.nlink !== 1 && stat.nlink !== 1n)) return;
  const exact = (value: number | bigint): bigint | undefined =>
    typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : undefined;
  const dev = exact(stat.dev), ino = exact(stat.ino);
  if (dev === undefined || ino === undefined || dev < 0n || ino < 0n ||
    (process.platform === "win32" && (dev === 0n || ino === 0n))) return;
  return { dev, ino };
}

async function captureChangedObservedFile(
  error: unknown,
  pathname: string,
  before: Stats | BigIntStats | undefined,
  observed: Stats | BigIntStats | undefined,
  assertParents: () => Promise<void> | void,
  proof: { failure?: StatLeafFailure },
): Promise<void> {
  try {
    const previous = singleLinkFileIdentity(before), current = singleLinkFileIdentity(observed);
    if (!previous || !current || (previous.dev === current.dev && previous.ino === current.ino)) return;
    await assertParents();
    // A changed metadata probe grants only a fresh acquisition attempt, never ownership.
    proof.failure = { error, kind: `stat-leaf-changed:${pathname}` };
  } catch {
    // Ambiguous file or ancestry observations retain the original public error.
  }
}

async function missingObservedFileError(
  cause: unknown,
  pathname: string,
  before: Stats | BigIntStats | undefined,
  assertParents: () => Promise<void> | void,
  proof: { failure?: StatLeafFailure },
): Promise<FsSafeError> {
  const failure = new FsSafeError("path-mismatch", "file changed during operation", errorCauseOptions(cause));
  if (hasNodeErrorCode(cause, "ENOENT") && before?.isFile() && !before.isSymbolicLink() &&
    (before.nlink === 1 || before.nlink === 1n)) {
    try {
      await assertParents();
      // Metadata loss permits discarding a probe, never reading or owning a file.
      proof.failure = { error: failure, kind: `stat-leaf-missing:${pathname}` };
    } catch {
      // Keep the public mismatch and withhold provenance when ancestry changed.
    }
  }
  return failure;
}

export async function statResolvedPathInRoot(
  root: RootContext,
  resolvedPath: string,
  receipt?: RootPathObservationReceipt,
): Promise<PathStat> {
  const proof: { failure?: StatLeafFailure } = {};
  try {
    // Nested observations in a hook cannot grant this invocation discard authority.
    return await fileObservation().run(() => statObservedPathInRoot(root, resolvedPath, proof, receipt));
  } catch (error) {
    const failure = proof.failure;
    if (failure && failure.error === error) recordFileObservationFailure(error, failure.kind);
    throw error;
  }
}

async function statObservedPathInRoot(
  root: RootContext,
  resolvedPath: string,
  proof: { failure?: StatLeafFailure },
  receipt?: RootPathObservationReceipt,
): Promise<PathStat> {
  let admittedTarget = false;
  try {
    if (receipt) {
      if (receipt.kind !== "stat" || receipt.targetPath !== resolvedPath) {
        throw new FsSafeError("path-mismatch", "file observation receipt does not match target");
      }
      admittedTarget = true;
      const beforeObservation = getFsSafeTestHooks()?.beforeRootStatObservation;
      if (beforeObservation) await beforeObservation(resolvedPath);
      let observed: Stats | BigIntStats;
      let sample: Stats | BigIntStats | undefined, samples = 0;
      const comparison = fileObservation();
      try {
        observed = comparison.run(() => assertStatObservationSync(
          bigint => {
            sample = bigint ? fsSync.lstatSync(resolvedPath, { bigint: true }) : fsSync.lstatSync(resolvedPath);
            samples += 1;
            return sample;
          },
          receipt.target.identity,
        ));
      } catch (error) {
        if (isNotFoundPathError(error)) {
          throw await missingObservedFileError(
            error, resolvedPath, "stat" in receipt.target ? receipt.target.stat : undefined,
            () => assertRootPathObservationReceiptCurrent(root, receipt),
            proof,
          );
        }
        if (comparison.has(error, "identity")) await captureChangedObservedFile(
          error, resolvedPath, "stat" in receipt.target ? receipt.target.stat : undefined,
          samples === 1 ? sample : undefined,
          () => assertRootPathObservationReceiptCurrent(root, receipt),
          proof,
        );
        throw error;
      }
      if (observed.isSymbolicLink()) {
        throw new FsSafeError("path-mismatch", "file changed during operation");
      }
      assertRootPathObservationReceiptCurrent(root, receipt, observed);
      return pathStatFromStats(observed);
    }
    const guardPath = resolvedPath === root.rootReal ? root.rootReal : path.dirname(resolvedPath);
    const parentGuard = guardPath === root.rootReal && root.rootGuard
      ? root.rootGuard
      : await createRootDirectoryObservationGuard(root, guardPath);
    let expected: BigIntStats;
    try {
      const beforeInitialObservation = getFsSafeTestHooks()?.beforeRootStatInitialObservation;
      if (beforeInitialObservation) await beforeInitialObservation(resolvedPath);
      expected = inspectFileIdentitySync(() => fsSync.lstatSync(resolvedPath, { bigint: true }));
      if (expected.isSymbolicLink()) {
        throw new FsSafeError("path-mismatch", "file changed during operation");
      }
    } catch (error) {
      // No initial target error is safe to expose until the admitted parent is
      // proven current; a redirect must win over an ordinary lookup failure.
      await assertRootDirectoryObservationGuard(root, parentGuard);
      throw error;
    }
    admittedTarget = true;
    const beforeObservation = getFsSafeTestHooks()?.beforeRootStatObservation;
    if (beforeObservation) await beforeObservation(resolvedPath);
    let observed: BigIntStats;
    let sample: BigIntStats | undefined, samples = 0;
    const comparison = fileObservation();
    try {
      observed = comparison.run(() => inspectFileIdentitySync(
        () => {
          sample = fsSync.lstatSync(resolvedPath, { bigint: true });
          samples += 1;
          return sample;
        },
        expected,
      ));
    } catch (error) {
      if (isNotFoundPathError(error)) {
        throw await missingObservedFileError(
          error, resolvedPath, expected,
          () => assertRootDirectoryObservationGuard(root, parentGuard),
          proof,
        );
      }
      if (comparison.has(error, "identity")) await captureChangedObservedFile(
        error, resolvedPath, expected, samples === 1 ? sample : undefined,
        () => assertRootDirectoryObservationGuard(root, parentGuard),
        proof,
      );
      throw error;
    }
    if (observed.isSymbolicLink()) {
      throw new FsSafeError("path-mismatch", "file changed during operation");
    }
    await assertRootDirectoryObservationGuard(root, parentGuard);
    return pathStatFromStats(observed);
  } catch (error) {
    if (!admittedTarget && isNotFoundPathError(error)) {
      throw fileNotFoundError(error instanceof Error ? error : undefined);
    }
    throw error;
  }
}
