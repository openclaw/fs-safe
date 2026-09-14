import fs from "node:fs";
import path from "node:path";
import { formatErrorDetail } from "./error-detail.js";
import { assertNoNulPathInput, hasNodeErrorCode } from "./path.js";
import { realpathSync } from "./realpath.js";
import { absolutePathWithRawSegments } from "./root-path-existing.js";

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
  const remaining = absolutePath.slice(resolved.length).split(path.sep);
  const visitedStates = new Set<string>();
  let symlinkHops = 0;

  while (remaining.length > 0) {
    const segment = remaining.shift()!;
    if (segment === "") continue;
    if (segment === "." || segment === "..") {
      const atRoot = resolved === rawRoot(resolved);
      const lookup = segment === ".." && atRoot ? "." : segment;
      // lstat(dir) does not test search permission, and realpath may erase dots.
      fs.lstatSync(`${resolved}${resolved.endsWith(path.sep) ? "" : path.sep}${lookup}`, { bigint: true });
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
        existingPath: realpathSync.native(resolved),
        unresolvedSegments: [segment, ...remaining],
      };
    }
    if (!stat.isSymbolicLink()) {
      if (!stat.isDirectory() && remaining.length > 0) throw resolutionError("ENOTDIR", absolutePath);
      resolved = candidate;
      continue;
    }
    const state = JSON.stringify([String(stat.dev), String(stat.ino), candidate, remaining]);
    if (symlinkHops >= 64 || visitedStates.has(state)) throw resolutionError("ELOOP", absolutePath);
    visitedStates.add(state);
    symlinkHops++;
    const target = fs.readlinkSync(candidate);
    const rawTarget = path.sep === "\\" ? target.replaceAll("/", "\\") : target;
    if (path.isAbsolute(rawTarget)) {
      const targetRoot = rawRoot(rawTarget);
      // A rooted Windows link target uses the link's drive/share, not cwd's.
      resolved = path.sep === "\\" && targetRoot === "\\" ? rawRoot(resolved) : targetRoot;
      remaining.unshift(...rawTarget.slice(targetRoot.length).split(path.sep));
    } else {
      // A target's parent traversal applies after resolving its preceding links.
      remaining.unshift(...rawTarget.split(path.sep));
    }
  }
  return { absolutePath, existingPath: realpathSync.native(resolved), unresolvedSegments: [] };
}
