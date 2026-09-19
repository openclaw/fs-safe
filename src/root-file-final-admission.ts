import fs from "node:fs";
import { FsSafeError } from "./errors.js";
import type { PinnedOpenSyncFinalAdmission } from "./pinned-open.js";
import { realpathSync } from "./realpath.js";
import { admitPathInsideRoot } from "./root-boundary.js";
import { hardlinkedPathNotAllowedError } from "./root-errors.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
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

function isExpectedPathError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function inspectCanonicalRoot(
  ioFs: RootFileAdmissionFs,
  rootPath: string,
  expected?: ExactIdentity,
): fs.BigIntStats {
  try {
    assertNoWindowsPathAlias(rootPath);
    const operationPath = ioFs === fs ? pathForWindowsFilesystem(rootPath) : rootPath;
    return inspectFileIdentitySync(() => {
      const stat = ioFs.lstatSync(operationPath, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw rootIdentityMismatch();
      return stat;
    }, expected);
  } catch (error) {
    if (expected && isExpectedPathError(error)) throw rootIdentityMismatch(error);
    throw error;
  }
}

export function observeCanonicalRoot(
  ioFs: RootFileAdmissionFs,
  rootPath: string,
): CanonicalRootObservation {
  try {
    const stat = inspectCanonicalRoot(ioFs, rootPath);
    const identity = Object.freeze({ dev: stat.dev, ino: stat.ino });
    let observedPath = rootPath;
    if (process.platform === "win32" && ioFs === fs) {
      // Native leaf resolution expands Windows short names. Bind that root
      // spelling before traversal without replacing the observed identity.
      observedPath = realpathSync.native(pathForWindowsFilesystem(rootPath));
      if (observedPath !== rootPath) inspectCanonicalRoot(ioFs, observedPath, identity);
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
  const inspectRoot = (candidateRootPath: string, expected: ExactIdentity) => {
    inspectCanonicalRoot(ioFs, candidateRootPath, expected);
  };
  return ({ path: consumedPath, descriptorIdentity }) => {
    inspectCanonicalRoot(ioFs, root.path, root.identity);
    const canonicalPath = resolveConsumedPath(ioFs, consumedPath);
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
      const current = inspectFileIdentitySync(
        () => ioFs.lstatSync(admitted.path, { bigint: true }),
        descriptorIdentity,
      );
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
    inspectCanonicalRoot(ioFs, root.path, root.identity);
    return admitted.path;
  };
}
