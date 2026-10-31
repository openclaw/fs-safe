import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import { formatErrorDetail } from "./error-detail.js";
import { assertNoNulPathInput, hasNodeErrorCode } from "./path.js";
import { realpathNative, realpathSync } from "./realpath.js";
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

// Leave ample room for ordinary shallow paths to retain the legacy small-array
// path. At 32 components, repeated front removal can reindex at most 496 array
// positions per constructed queue; longer queues use a forward cursor instead.
const SHIFT_QUEUE_COMPONENT_LIMIT = 32;

type PathRead = () => Promise<void>;

function* read<T>(operation: () => Promise<T>): Generator<PathRead, T> {
  let value!: T;
  yield async () => { value = await operation(); };
  return value;
}

function* resolvePrefix(input: string, synchronous = false): Generator<PathRead, ResolvedPathPrefix> {
  assertNoNulPathInput(input);
  const absolutePath = absolutePathWithRawSegments(input);
  let resolved = rawRoot(absolutePath);
  let remaining = absolutePath.slice(resolved.length).split(path.sep);
  let shiftQueue = remaining.length <= SHIFT_QUEUE_COMPONENT_LIMIT;
  let nextSegment = 0;
  let remainingCount = remaining.length;
  const visitedStates = new Set<string>();
  let symlinkHops = 0;

  while (remainingCount > 0) {
    const segment = shiftQueue ? remaining.shift()! : remaining[nextSegment++]!;
    remainingCount--;
    if (segment === "") continue;
    if (segment === "." || segment === "..") {
      const atRoot = resolved === rawRoot(resolved);
      const lookup = segment === ".." && atRoot ? "." : segment;
      // lstat(dir) does not test search permission, and realpath may erase dots.
      const operationBase = pathForWindowsFilesystem(resolved);
      const lookupPath = `${operationBase}${operationBase.endsWith(path.sep) ? "" : path.sep}${lookup}`;
      if (synchronous) fs.lstatSync(lookupPath, { bigint: true });
      else yield* read(() => asyncFs.lstat(lookupPath, { bigint: true }));
      if (segment === ".." && !atRoot) resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, segment);
    let stat: fs.BigIntStats;
    try {
      stat = synchronous ? fs.lstatSync(candidate, { bigint: true })
        : yield* read(() => asyncFs.lstat(candidate, { bigint: true }));
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT")) throw error;
      return {
        absolutePath,
        existingPath: synchronous ? realpathSync.native(pathForWindowsFilesystem(resolved))
          : yield* read(() => realpathNative(pathForWindowsFilesystem(resolved))),
        unresolvedSegments: shiftQueue ? [segment, ...remaining] : remaining.slice(nextSegment - 1),
      };
    }
    if (!stat.isSymbolicLink()) {
      if (!stat.isDirectory() && remainingCount > 0) throw resolutionError("ENOTDIR", absolutePath);
      resolved = candidate;
      continue;
    }
    const pendingSuffix = shiftQueue ? remaining : remaining.slice(nextSegment);
    const state = JSON.stringify([String(stat.dev), String(stat.ino), candidate, pendingSuffix]);
    if (symlinkHops >= 64 || visitedStates.has(state)) throw resolutionError("ELOOP", absolutePath);
    visitedStates.add(state);
    symlinkHops++;
    const target = synchronous ? fs.readlinkSync(candidate) : yield* read(() => asyncFs.readlink(candidate));
    const rawTarget = path.sep === "\\" ? target.replaceAll("/", "\\") : target;
    let targetSegments: string[];
    if (path.isAbsolute(rawTarget)) {
      const targetRoot = rawRoot(rawTarget);
      // A rooted Windows link target uses the link's drive/share, not cwd's.
      resolved = path.sep === "\\" && targetRoot === "\\" ? rawRoot(resolved) : targetRoot;
      targetSegments = rawTarget.slice(targetRoot.length).split(path.sep);
    } else {
      // A target's parent traversal applies after resolving its preceding links.
      targetSegments = rawTarget.split(path.sep);
    }
    const expandedCount = targetSegments.length + pendingSuffix.length;
    if (expandedCount <= SHIFT_QUEUE_COMPONENT_LIMIT) {
      // The spread is bounded by the same fixed limit as subsequent shifts.
      remaining = pendingSuffix;
      remaining.unshift(...targetSegments);
    } else {
      remaining = targetSegments.concat(pendingSuffix);
    }
    remainingCount = remaining.length;
    shiftQueue = remainingCount <= SHIFT_QUEUE_COMPONENT_LIMIT;
    nextSegment = 0;
  }
  return { absolutePath, existingPath: synchronous ? realpathSync.native(pathForWindowsFilesystem(resolved))
          : yield* read(() => realpathNative(pathForWindowsFilesystem(resolved))), unresolvedSegments: [] };
}

export function resolvePathPrefixSync(input: string): ResolvedPathPrefix {
  const result = resolvePrefix(input, true).next();
  if (!result.done) throw new Error("Synchronous path prefix resolution yielded asynchronous IO");
  return result.value;
}

export async function resolvePathPrefix(input: string): Promise<ResolvedPathPrefix> {
  if (process.platform !== "win32" && !process.versions.bun) {
    assertNoNulPathInput(input);
    const absolutePath = absolutePathWithRawSegments(input);
    let entry: fs.Stats | undefined;
    try { entry = await asyncFs.lstat(absolutePath); }
    catch (error) {
      if (hasNodeErrorCode(error, "ENOENT") && absolutePath === path.resolve(absolutePath)) {
        // The leaf is absent, so only its nearest existing directory is needed.
        // Stop at aliases: dangling targets still require physical expansion.
        for (let parent = path.dirname(absolutePath); ; parent = path.dirname(parent)) {
          let stat: fs.Stats;
          try { stat = await asyncFs.lstat(parent); }
          catch (error) {
            if (hasNodeErrorCode(error, "ENOENT") && path.dirname(parent) !== parent) continue;
            break;
          }
          if (!stat.isDirectory()) break;
          return {
            absolutePath,
            existingPath: await realpathNative(parent),
            unresolvedSegments: absolutePath.slice(parent.length + (parent.endsWith(path.sep) ? 0 : 1)).split(path.sep),
          };
        }
      }
    }
    if (entry) {
      try {
        // lstat checked raw parent traversal; a final link also needs its target's search permissions.
        if (entry.isSymbolicLink()) await asyncFs.access(absolutePath);
        return { absolutePath, existingPath: await realpathNative(absolutePath), unresolvedSegments: [] };
      } catch {
        // Raw suffixes, dangling links and uncertain failures retain the walker.
      }
    }
  }
  const reads = resolvePrefix(input);
  let step = reads.next();
  while (!step.done) {
    try { await step.value(); }
    catch (error) { step = reads.throw(error); continue; }
    step = reads.next();
  }
  return step.value;
}
