import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { isNotFoundPathError } from "./path.js";
import { realpathSync } from "./realpath.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

export type MutationIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
}>;

const checkedDirectoryObservation = Symbol("checked mutation directory observation");
const directoryObservers = new WeakMap<MutationDirectoryObservation, MutationDirectoryObserver>();

export type MutationDirectoryCurrent = Readonly<{
  canonicalPath: string;
  identity: MutationIdentity;
}>;
export type MutationDirectoryObserver = () => MutationDirectoryCurrent | undefined;

export type MutationDirectoryObservation = Readonly<{
  path: string;
  canonicalPath: string;
  identity: MutationIdentity;
  [checkedDirectoryObservation]: true;
}>;

export type MutationPathObservation = Readonly<{
  path: string;
  ancestor: string;
  canonicalAncestor: string;
  canonicalPath: string;
  entry: MutationIdentity;
  identity: MutationIdentity;
  missingSegments: readonly string[];
  missingOffset: number;
}>;

function identity(stat: Pick<BigIntStats, "dev" | "ino" | "mode" | "nlink">): MutationIdentity {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink });
}

function sameIdentity(
  left: MutationIdentity,
  right: Pick<MutationIdentity, "dev" | "ino" | "mode" | "nlink">,
  directory = false,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    // mkdir changes a parent's link count. File link counts remain live evidence.
    (directory || left.nlink === right.nlink);
}

function directoryMode(mode: bigint): boolean {
  return (mode & 0o170000n) === 0o040000n;
}

function absent(pathname: string): boolean {
  try {
    return fs.lstatSync(pathname, { throwIfNoEntry: false }) === undefined;
  } catch (error) {
    // ENOTDIR is incomplete evidence, not a missing child of a directory.
    return isNotFoundPathError(error) && (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function missingMutationSegments(observation: MutationPathObservation): number {
  return observation.missingSegments.length - observation.missingOffset;
}

export function nextMissingMutationPath(observation: MutationPathObservation): string | undefined {
  const segment = observation.missingSegments[observation.missingOffset];
  return segment === undefined ? undefined : path.join(observation.ancestor, segment);
}

// Callers may construct this only from their just-completed exact pathname and
// canonical fences. The private brand prevents unverified structural objects
// from advancing an admission epoch.
export function checkedMutationDirectory(
  pathname: string,
  canonicalPath: string,
  stat: Pick<BigIntStats, "dev" | "ino" | "mode" | "nlink">,
  observeCurrent?: MutationDirectoryObserver,
): MutationDirectoryObservation {
  if (!directoryMode(stat.mode)) {
    throw new TypeError("mutation directory evidence must describe a real directory");
  }
  const observation = Object.freeze({
    path: pathname,
    canonicalPath,
    identity: identity(stat),
    [checkedDirectoryObservation]: true as const,
  });
  if (observeCurrent) directoryObservers.set(observation, observeCurrent);
  return observation;
}

function checkedDirectory(observation: MutationDirectoryObservation): boolean {
  return observation[checkedDirectoryObservation] === true &&
    path.isAbsolute(observation.path) && path.isAbsolute(observation.canonicalPath) &&
    directoryMode(observation.identity.mode);
}

export function mutationDirectoryObservationCurrent(
  observation: MutationDirectoryObservation,
): boolean {
  if (!checkedDirectory(observation)) return false;
  try {
    const observed = directoryObservers.get(observation)?.();
    if (observed) {
      return directoryMode(observed.identity.mode) &&
        sameIdentity(observation.identity, observed.identity) &&
        observed.canonicalPath === observation.canonicalPath;
    }
    const stat = inspectFileIdentitySync(() => fs.lstatSync(observation.path, { bigint: true }));
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      sameIdentity(observation.identity, stat) &&
      realpathSync.native(observation.path) === observation.canonicalPath;
  } catch {
    return false;
  }
}

export function mutationObservationUsesDirectory(
  observation: MutationPathObservation,
  directory: MutationDirectoryObservation,
): boolean {
  return checkedDirectory(directory) &&
    observation.ancestor === directory.path &&
    observation.canonicalAncestor === directory.canonicalPath &&
    sameIdentity(observation.entry, directory.identity) &&
    sameIdentity(observation.identity, directory.identity);
}

// Optional evidence only: failures select full admission, never a new error order.
export function observeMutationPath(pathname: string): MutationPathObservation | undefined {
  try {
    let ancestor = pathname;
    const reversedMissing: string[] = [];
    while (absent(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return undefined;
      reversedMissing.push(path.basename(ancestor));
      ancestor = parent;
    }
    reversedMissing.reverse();
    const missingSegments = Object.freeze(reversedMissing);
    const entry = inspectFileIdentitySync(() => fs.lstatSync(ancestor, { bigint: true }));
    const canonicalAncestor = realpathSync.native(ancestor);
    const stat = canonicalAncestor === ancestor ? entry :
      inspectFileIdentitySync(() => fs.lstatSync(canonicalAncestor, { bigint: true }));
    if (stat.isSymbolicLink() || (missingSegments.length > 0 && !stat.isDirectory())) return undefined;
    const observation = Object.freeze({
      path: pathname, ancestor, canonicalAncestor,
      canonicalPath: path.join(canonicalAncestor, ...missingSegments),
      entry: identity(entry), identity: identity(stat), missingSegments, missingOffset: 0,
    });
    return mutationObservationCurrent(observation) ? observation : undefined;
  } catch {
    return undefined;
  }
}

export function mutationObservationCurrent(observation: MutationPathObservation): boolean {
  try {
    const entry = inspectFileIdentitySync(() => fs.lstatSync(observation.ancestor, { bigint: true }));
    if (!sameIdentity(observation.entry, entry, entry.isDirectory()) ||
      realpathSync.native(observation.ancestor) !== observation.canonicalAncestor) return false;
    const stat = observation.canonicalAncestor === observation.ancestor ? entry :
      inspectFileIdentitySync(() => fs.lstatSync(observation.canonicalAncestor, { bigint: true }));
    return sameIdentity(observation.identity, stat, stat.isDirectory()) &&
      (missingMutationSegments(observation) === 0 ||
        (stat.isDirectory() && absent(nextMissingMutationPath(observation)!)));
  } catch {
    return false;
  }
}

// Share only ordinary spelling observations collected in this synchronous
// phase. Aliases retain their independent raw/canonical binding checks, and no
// fact escapes this call or crosses an authority callback or mutation.
export function mutationObservationsCurrent(
  observations: readonly MutationPathObservation[],
  directories: readonly MutationDirectoryObservation[],
): boolean {
  type Group = {
    observations: MutationPathObservation[];
    directories: MutationDirectoryObservation[];
  };
  const groups = new Map<string, Group>();
  const groupFor = (pathname: string): Group => {
    let group = groups.get(pathname);
    if (!group) {
      group = { observations: [], directories: [] };
      groups.set(pathname, group);
    }
    return group;
  };
  try {
    for (const observation of observations) {
      if (observation.ancestor !== observation.canonicalAncestor) {
        if (!mutationObservationCurrent(observation)) return false;
      } else {
        groupFor(observation.ancestor).observations.push(observation);
      }
    }
    for (const directory of directories) {
      if (!checkedDirectory(directory)) return false;
      groupFor(directory.path).directories.push(directory);
    }
    const current = (pathname: string, group: Group): boolean => {
      const missing = new Set(group.observations.flatMap((observation) => {
        const next = nextMissingMutationPath(observation);
        return next === undefined ? [] : [next];
      }));
      // Exact directory roles are the end fence. Observe missing children
      // before refreshing that parent, matching the ordered admission fence.
      if (group.directories.length && ![...missing].every(absent)) return false;
      const observed = group.directories.length
        ? directoryObservers.get(group.directories[0]!)?.() : undefined;
      const stat = observed?.identity ??
        inspectFileIdentitySync(() => fs.lstatSync(pathname, { bigint: true }));
      const canonical = observed?.canonicalPath ?? realpathSync.native(pathname);
      const isDirectory = directoryMode(stat.mode);
      if (!group.observations.every((observation) =>
        canonical === observation.canonicalAncestor &&
        sameIdentity(observation.entry, stat, isDirectory) &&
        sameIdentity(observation.identity, stat, isDirectory) &&
        (missingMutationSegments(observation) === 0 || isDirectory))) return false;
      if (!group.directories.every((directory) =>
        isDirectory &&
        sameIdentity(directory.identity, stat) && canonical === directory.canonicalPath)) return false;
      return group.directories.length > 0 || [...missing].every(absent);
    };
    for (const [pathname, group] of groups) {
      if (!group.directories.length && !current(pathname, group)) return false;
    }
    // Preserve the supplied parent/child order, even when a directory also
    // appeared earlier as the Root or a denied path's nearest ancestor.
    const checked = new Set<string>();
    for (const directory of directories) {
      if (checked.has(directory.path)) continue;
      if (!current(directory.path, groups.get(directory.path)!)) return false;
      checked.add(directory.path);
    }
    return true;
  } catch {
    return false;
  }
}

// This is deliberately a pure tentative update. The immediately following
// parent authorization validates the complete epoch once before reusing it.
export function advanceMutationObservation(
  observation: MutationPathObservation,
  parent: MutationDirectoryObservation,
  child: MutationDirectoryObservation,
): MutationPathObservation | undefined {
  const nextMissingPath = nextMissingMutationPath(observation);
  if (nextMissingPath === undefined || nextMissingPath !== child.path) return observation;
  if (!checkedDirectory(parent) || !checkedDirectory(child) ||
    observation.ancestor !== parent.path || observation.canonicalAncestor !== parent.canonicalPath ||
    !sameIdentity(observation.entry, parent.identity, true) ||
    !sameIdentity(observation.identity, parent.identity, true) ||
    parent.path !== parent.canonicalPath || child.path !== child.canonicalPath ||
    path.dirname(child.path) !== parent.path) return undefined;
  return Object.freeze({
    ...observation,
    ancestor: child.path,
    canonicalAncestor: child.canonicalPath,
    entry: child.identity,
    identity: child.identity,
    missingOffset: observation.missingOffset + 1,
  });
}
