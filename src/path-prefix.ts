import fs from "node:fs";
import path from "node:path";
import { formatErrorDetail } from "./error-detail.js";
import { assertNoNulPathInput, hasNodeErrorCode } from "./path.js";
import { realpathSync } from "./realpath.js";
import { absolutePathWithRawSegments } from "./root-path-existing.js";
import { pathForWindowsFilesystem } from "./windows-path-alias.js";

export type ResolvedPathPrefix = {
  readonly absolutePath: string;
  readonly existingPath: string;
  readonly unresolvedSegments: readonly string[];
};

function rawRoot(absolutePath: string): string {
  if (path.sep === "\\" && /^\\\\[?.]\\UNC\\/i.test(absolutePath)) {
    // Node parses only the namespace prefix as the root of an extended UNC path.
    const shareRoot = path.parse(`\\\\${absolutePath.slice(8)}`).root;
    return absolutePath.slice(0, shareRoot.length + 6);
  }
  return path.parse(absolutePath).root;
}

function resolutionError(code: "ELOOP" | "ENOTDIR", absolutePath: string): Error {
  const detail = code === "ELOOP" ? "too many symbolic links" : "not a directory";
  return Object.assign(new Error(`${code}: ${detail}, resolvePathPrefix ${formatErrorDetail(absolutePath)}`), {
    code, syscall: "resolvePathPrefix", path: absolutePath,
  });
}

export function resolvePathPrefixSync(input: string): ResolvedPathPrefix {
  assertNoNulPathInput(input);
  const absolutePath = absolutePathWithRawSegments(input);
  let resolved = rawRoot(absolutePath);
  let remaining = absolutePath.slice(resolved.length).split(path.sep);
  let nextSegment = 0;
  const visitedStates = new Set<string>();
  let symlinkHops = 0;

  while (nextSegment < remaining.length) {
    const segment = remaining[nextSegment++]!;
    if (segment === "") continue;
    if (segment === "." || segment === "..") {
      const atRoot = resolved === rawRoot(resolved);
      const lookup = segment === ".." && atRoot ? "." : segment;
      // lstat(dir) does not test search permission, and realpath may erase dots.
      const operationBase = pathForWindowsFilesystem(resolved);
      fs.lstatSync(`${operationBase}${operationBase.endsWith(path.sep) ? "" : path.sep}${lookup}`, { bigint: true });
      if (segment === ".." && !atRoot) resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, segment);
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(candidate, { bigint: true });
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT")) throw error;
      return {
        absolutePath,
        existingPath: realpathSync.native(pathForWindowsFilesystem(resolved)),
        unresolvedSegments: remaining.slice(nextSegment - 1),
      };
    }
    if (!stat.isSymbolicLink()) {
      if (!stat.isDirectory() && nextSegment < remaining.length) throw resolutionError("ENOTDIR", absolutePath);
      resolved = candidate;
      continue;
    }
    const pendingSuffix = remaining.slice(nextSegment);
    const state = JSON.stringify([String(stat.dev), String(stat.ino), candidate, pendingSuffix]);
    if (symlinkHops >= 64 || visitedStates.has(state)) throw resolutionError("ELOOP", absolutePath);
    visitedStates.add(state);
    symlinkHops++;
    const target = fs.readlinkSync(candidate);
    const rawTarget = path.sep === "\\" ? target.replaceAll("/", "\\") : target;
    if (path.isAbsolute(rawTarget)) {
      const targetRoot = rawRoot(rawTarget);
      // A rooted Windows link target uses the link's drive/share, not cwd's.
      resolved = path.sep === "\\" && targetRoot === "\\" ? rawRoot(resolved) : targetRoot;
      remaining = rawTarget.slice(targetRoot.length).split(path.sep).concat(pendingSuffix);
    } else {
      // A target's parent traversal applies after resolving its preceding links.
      remaining = rawTarget.split(path.sep).concat(pendingSuffix);
    }
    nextSegment = 0;
  }
  return { absolutePath, existingPath: realpathSync.native(pathForWindowsFilesystem(resolved)), unresolvedSegments: [] };
}
