import { formatErrorDetail, shortPath } from "./error-detail.js";

const rootPathEscapeErrors = new WeakSet<Error>();

function rootPathEscapeError(message: string): Error {
  const error = new Error(message);
  rootPathEscapeErrors.add(error);
  return error;
}

export function isRootPathEscapeError(error: unknown): error is Error {
  return error instanceof Error && rootPathEscapeErrors.has(error);
}

export function sanitizeRootPathError(error: unknown): unknown {
  if (error instanceof Error) {
    error.message = formatErrorDetail(error.message);
  }
  return error;
}

export function pathEscapeError(params: {
  boundaryLabel: string;
  rootPath: string;
  absolutePath: string;
}): Error {
  return rootPathEscapeError(
    `Path escapes ${params.boundaryLabel} (${shortPath(params.rootPath)}): ${shortPath(params.absolutePath)}`,
  );
}

export function symlinkEscapeError(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  symlinkPath: string;
}): Error {
  return rootPathEscapeError(
    `Symlink escapes ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.symlinkPath)}`,
  );
}
