import fs from "node:fs";
import asyncFs from "node:fs/promises";
import { runAsync, runSync, wait, type Procedure } from "./atomic-io.js";
import { FsSafeError } from "./errors.js";
import { isExpectedPathError, type PinnedOpenSyncFinalAdmission } from "./pinned-open.js";
import { realpathNative, realpathSync } from "./realpath.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { hardlinkedPathNotAllowedError } from "./root-errors.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem } from "./windows-path-alias.js";

export type RootFileAdmissionFs = Pick<typeof fs, "lstatSync" | "realpathSync">;

type ExactIdentity = Readonly<{ dev: bigint; ino: bigint }>;

export type CanonicalRootObservation =
  | { ok: true; path: string; identity: ExactIdentity }
  | { ok: false; error: unknown };

function rootIdentityMismatch(cause?: unknown): FsSafeError {
  return new FsSafeError(
    "path-mismatch",
    "canonical root directory identity changed or could not be verified",
    cause === undefined ? {} : { cause },
  );
}

function* inspectCanonicalRoot(
  ioFs: RootFileAdmissionFs,
  rootPath: string,
  expected?: ExactIdentity,
  asynchronous = false,
): Procedure<fs.BigIntStats> {
  try {
    assertNoWindowsPathAlias(rootPath);
    const operationPath = ioFs === fs ? pathForWindowsFilesystem(rootPath) : rootPath;
    const inspect = (stat: fs.BigIntStats) => {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw rootIdentityMismatch();
      return stat;
    };
    return asynchronous
      ? yield* wait(inspectFileIdentity(async () => inspect(await asyncFs.lstat(operationPath, { bigint: true })), expected))
      : inspectFileIdentitySync(() => inspect(ioFs.lstatSync(operationPath, { bigint: true })), expected);
  } catch (error) {
    if (expected && isExpectedPathError(error)) throw rootIdentityMismatch(error);
    throw error;
  }
}

export function observeCanonicalRoot(
  ioFs: RootFileAdmissionFs,
  rootPath: string,
): CanonicalRootObservation {
  return runSync(observeCanonicalRootProcedure(ioFs, rootPath, false));
}

export function observeCanonicalRootAsync(rootPath: string): Promise<CanonicalRootObservation> {
  return runAsync(observeCanonicalRootProcedure(fs, rootPath, true));
}

function* observeCanonicalRootProcedure(ioFs: RootFileAdmissionFs, rootPath: string, asynchronous: boolean): Procedure<CanonicalRootObservation> {
  try {
    const stat = yield* inspectCanonicalRoot(ioFs, rootPath, undefined, asynchronous);
    const identity = Object.freeze({ dev: stat.dev, ino: stat.ino });
    let observedPath = rootPath;
    if (ioFs === fs) {
      // Match native leaf resolution (including case and Windows short names)
      // without replacing the already observed root identity.
      const operationPath = pathForWindowsFilesystem(rootPath);
      observedPath = asynchronous ? yield* wait(realpathNative(operationPath)) : realpathSync.native(operationPath);
      if (observedPath !== rootPath) yield* inspectCanonicalRoot(ioFs, observedPath, identity, asynchronous);
    }
    return { ok: true, path: observedPath, identity };
  } catch (error) {
    return { ok: false, error };
  }
}

function resolveConsumedPath(ioFs: RootFileAdmissionFs, filePath: string): string {
  return ioFs === fs ? realpathSync.native(filePath) : ioFs.realpathSync(filePath);
}

export function createRootFileFinalAdmission(
  ioFs: RootFileAdmissionFs,
  root: Extract<CanonicalRootObservation, { ok: true }>,
  boundaryLabel: string,
  rejectHardlinks = true,
): PinnedOpenSyncFinalAdmission {
  return params => runSync(admitRootFile(ioFs, root, boundaryLabel, rejectHardlinks, params, false));
}

export function createRootFileFinalAdmissionAsync(
  root: Extract<CanonicalRootObservation, { ok: true }>, boundaryLabel: string, rejectHardlinks: boolean,
): (params: Parameters<PinnedOpenSyncFinalAdmission>[0]) => Promise<string> {
  return params => runAsync(admitRootFile(fs, root, boundaryLabel, rejectHardlinks, params, true));
}

function* admitRootFile(
  ioFs: RootFileAdmissionFs, root: Extract<CanonicalRootObservation, { ok: true }>,
  boundaryLabel: string, rejectHardlinks: boolean,
  { path: consumedPath, descriptorIdentity }: Parameters<PinnedOpenSyncFinalAdmission>[0],
  asynchronous: boolean,
): Procedure<string> {
  const inspectRoot = (candidateRootPath: string, expected: ExactIdentity) => {
    runSync(inspectCanonicalRoot(ioFs, candidateRootPath, expected));
  };
  yield* inspectCanonicalRoot(ioFs, root.path, root.identity, asynchronous);
  const canonicalPath = asynchronous ? yield* wait(realpathNative(consumedPath)) : resolveConsumedPath(ioFs, consumedPath);
  assertNoWindowsPathAlias(canonicalPath, "filesystem", "resolved file path uses a Windows filesystem namespace alias");
  const admitted = admitPathInsideRoot({
    rootPath: root.path,
    candidatePath: canonicalPath,
    rootIdentity: root.identity,
    inspectCandidateRoot: inspectRoot,
  });
  if (!admitted) {
    throw new FsSafeError(
      "outside-workspace",
      `resolved path escapes ${boundaryLabel}`,
    );
  }
  try {
    const current = asynchronous
      ? yield* wait(inspectFileIdentity(() => asyncFs.lstat(admitted.path, { bigint: true }), descriptorIdentity))
      : inspectFileIdentitySync(() => ioFs.lstatSync(admitted.path, { bigint: true }), descriptorIdentity);
    if (rejectHardlinks && current.isFile() && current.nlink > 1n) throw hardlinkedPathNotAllowedError();
  } catch (error) {
    if (isExpectedPathError(error)) {
      throw new FsSafeError(
        "path-mismatch",
        "canonical file identity changed or could not be verified",
        { cause: error },
      );
    }
    throw error;
  }
  yield* inspectCanonicalRoot(ioFs, root.path, root.identity, asynchronous);
  return admitted.path;
}
