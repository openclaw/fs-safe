import path from "node:path";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { isPathRelativeEscape } from "./path.js";
import { realpathSync } from "./realpath.js";

export type RootBoundaryIdentity = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
}>;

export type AdmittedRootPath = Readonly<{
  path: string;
  relativePath: string;
  admission: "exact" | "identity";
}>;

type WindowsRootPrefix = Readonly<{
  candidateRootPath: string;
  path: string;
  relativePath: string;
  admission: "exact" | "identity";
}>;

type WindowsComparablePath = Readonly<{
  comparison: string;
  original: string;
  originalIndex(comparisonIndex: number): number;
}>;

function windowsComparablePath(value: string, normalize: boolean): WindowsComparablePath {
  const original = normalize
    ? path.win32.normalize(value.replaceAll("/", "\\"))
    : value.replaceAll("/", "\\");
  if (/^\\\\\?\\UNC\\/i.test(original)) {
    return {
      original,
      comparison: `\\\\${original.slice(8)}`,
      originalIndex: (comparisonIndex) => comparisonIndex + 6,
    };
  }
  if (original.startsWith("\\\\?\\")) {
    return {
      original,
      comparison: original.slice(4),
      originalIndex: (comparisonIndex) => comparisonIndex + 4,
    };
  }
  return { original, comparison: original, originalIndex: (comparisonIndex) => comparisonIndex };
}

function trimWindowsTrailingSeparators(value: string): string {
  const rootLength = path.win32.parse(value).root.length;
  let end = value.length;
  while (end > rootLength && value[end - 1] === "\\") end -= 1;
  return value.slice(0, end);
}

function trimWindowsLeadingSeparators(value: string): string {
  let start = 0;
  while (value[start] === "\\") start += 1;
  return value.slice(start);
}

function exactWindowsRootPrefix(rootPath: string, candidatePath: string): WindowsRootPrefix | undefined {
  const root = trimWindowsTrailingSeparators(rootPath.replaceAll("/", "\\"));
  const candidate = candidatePath.replaceAll("/", "\\");
  let relativePath: string;
  if (candidate === root) {
    relativePath = "";
  } else {
    const rootWithSep = root.endsWith("\\") ? root : `${root}\\`;
    if (!candidate.startsWith(rootWithSep)) return undefined;
    relativePath = trimWindowsLeadingSeparators(candidate.slice(rootWithSep.length));
  }
  return {
    admission: "exact",
    candidateRootPath: root,
    path: relativePath === "" ? root : `${root}${root.endsWith("\\") ? "" : "\\"}${relativePath}`,
    relativePath,
  };
}

function windowsRootPrefix(rootPath: string, candidatePath: string): WindowsRootPrefix | undefined {
  const exact = exactWindowsRootPrefix(rootPath, candidatePath);
  if (exact) return exact;
  const trusted = windowsComparablePath(rootPath, true);
  const supplied = windowsComparablePath(candidatePath, false);
  const root = trimWindowsTrailingSeparators(trusted.original);
  const rootComparison = trimWindowsTrailingSeparators(trusted.comparison);
  const candidate = supplied.comparison;
  if (!path.win32.isAbsolute(supplied.original)) return undefined;

  let relativePath: string;
  let candidateRootPath: string;
  let admission: "exact" | "identity";
  if (candidate === rootComparison) {
    relativePath = "";
    candidateRootPath = supplied.original;
    admission = "exact";
  } else if (candidate.toLowerCase() === rootComparison.toLowerCase()) {
    relativePath = "";
    candidateRootPath = supplied.original;
    admission = "identity";
  } else {
    const rootWithSep = rootComparison.endsWith("\\") ? rootComparison : `${rootComparison}\\`;
    const candidatePrefix = candidate.slice(0, rootWithSep.length);
    if (candidatePrefix === rootWithSep) {
      admission = "exact";
    } else if (candidatePrefix.toLowerCase() === rootWithSep.toLowerCase()) {
      admission = "identity";
    } else {
      return undefined;
    }
    relativePath = trimWindowsLeadingSeparators(candidate.slice(rootWithSep.length));
    candidateRootPath = supplied.original.slice(0, supplied.originalIndex(rootComparison.length));
  }

  const rebasedPath = relativePath === ""
    ? root
    : `${root}${root.endsWith("\\") ? "" : "\\"}${relativePath}`;
  return { candidateRootPath, path: rebasedPath, relativePath, admission };
}

function exactRootIdentity(
  rootPath: string,
  expected?: RootBoundaryIdentity,
): { dev: bigint; ino: bigint } {
  if (typeof expected?.dev === "bigint" && typeof expected.ino === "bigint") {
    return { dev: expected.dev, ino: expected.ino };
  }
  const observed = inspectDirectoryIdentitySync(rootPath);
  return { dev: observed.dev, ino: observed.ino };
}

/**
 * Admit a path at a trusted directory boundary.
 *
 * On Windows, an exact structural prefix is allocation-only and performs no
 * filesystem observation. A match which depends on case folding is accepted
 * only when the candidate prefix names the exact trusted root object. Accepted
 * paths are always returned under the trusted root spelling.
 */
export function admitPathInsideRoot(params: {
  rootPath: string;
  candidatePath: string;
  rootIdentity?: RootBoundaryIdentity;
  resolveCandidateRoot?: boolean;
  identityCache?: Map<string, boolean>;
}): AdmittedRootPath | undefined {
  // Some platform-fallback tests intentionally spoof process.platform while
  // retaining Node's POSIX path module. A single-slash absolute root remains
  // unambiguously POSIX; double-slash and slash-backslash roots are reserved
  // for the synthetic Windows namespace cases below.
  const usesPosixBoundary = process.platform !== "win32" || (
    path.sep === "/" &&
    params.rootPath.startsWith("/") &&
    params.rootPath[1] !== "/" &&
    params.rootPath[1] !== "\\"
  );
  if (usesPosixBoundary) {
    if (
      params.rootPath.startsWith("/") &&
      params.candidatePath.startsWith("/") &&
      !params.candidatePath.includes("/..") &&
      (params.candidatePath === params.rootPath ||
        (params.candidatePath.startsWith(params.rootPath) &&
          (params.rootPath.endsWith("/") || params.candidatePath[params.rootPath.length] === "/")))
    ) {
      const relativeStart = params.rootPath.endsWith("/")
        ? params.rootPath.length
        : params.rootPath.length + 1;
      return {
        admission: "exact",
        path: params.candidatePath,
        relativePath: params.candidatePath === params.rootPath
          ? ""
          : params.candidatePath.slice(relativeStart),
      };
    }
    const root = path.resolve(params.rootPath);
    const candidate = path.resolve(params.candidatePath);
    const relativePath = path.relative(root, candidate);
    if (isPathRelativeEscape(relativePath)) return undefined;
    return { path: candidate, relativePath: relativePath === "." ? "" : relativePath, admission: "exact" };
  }

  const match = windowsRootPrefix(params.rootPath, params.candidatePath);
  if (!match) return undefined;
  const admitted = (): AdmittedRootPath => ({
    admission: match.admission,
    path: match.path,
    relativePath: match.relativePath,
  });
  if (match.admission === "exact") return admitted();
  const cached = params.identityCache?.get(match.candidateRootPath);
  if (cached !== undefined) return cached ? admitted() : undefined;

  try {
    const expected = exactRootIdentity(params.rootPath, params.rootIdentity);
    const candidateRootPath = params.resolveCandidateRoot
      ? realpathSync.native(match.candidateRootPath)
      : match.candidateRootPath;
    inspectDirectoryIdentitySync(candidateRootPath, expected);
    params.identityCache?.set(match.candidateRootPath, true);
    return admitted();
  } catch {
    params.identityCache?.set(match.candidateRootPath, false);
    return undefined;
  }
}
