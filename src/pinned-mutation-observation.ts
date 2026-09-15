import fs from "node:fs";
import path from "node:path";
import { isNotFoundPathError } from "./path.js";
import { realpathSync } from "./realpath.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

type Identity = Readonly<{ dev: bigint; ino: bigint; mode: bigint; nlink: bigint }>;

export type MutationDirectoryObservation = Readonly<{
  path: string;
  realPath: string;
  dev: bigint;
  ino: bigint;
}>;

export type MutationPathObservation = Readonly<{
  path: string;
  ancestor: string;
  canonicalAncestor: string;
  canonicalPath: string;
  entry: Identity;
  identity: Identity;
  missing: readonly string[];
}>;

function identity(stat: fs.BigIntStats): Identity {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink });
}

function sameIdentity(left: Identity, right: Identity, directory = false): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    // mkdir changes a parent's link count. File link counts remain live evidence.
    (directory || left.nlink === right.nlink);
}

function absent(pathname: string): boolean {
  try {
    fs.lstatSync(pathname);
    return false;
  } catch (error) {
    // ENOTDIR is incomplete evidence, not a missing child of a directory.
    return isNotFoundPathError(error) && (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

// Optional evidence only: failures select full admission, never a new error order.
export function observeMutationPath(pathname: string): MutationPathObservation | undefined {
  try {
    let ancestor = pathname;
    const missing: string[] = [];
    while (absent(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return undefined;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    const entry = inspectFileIdentitySync(() => fs.lstatSync(ancestor, { bigint: true }));
    const canonicalAncestor = realpathSync.native(ancestor);
    const stat = canonicalAncestor === ancestor ? entry :
      inspectFileIdentitySync(() => fs.lstatSync(canonicalAncestor, { bigint: true }));
    if (stat.isSymbolicLink() || (missing.length > 0 && !stat.isDirectory())) return undefined;
    const observation = Object.freeze({
      path: pathname, ancestor, canonicalAncestor,
      canonicalPath: path.join(canonicalAncestor, ...missing),
      entry: identity(entry), identity: identity(stat), missing: Object.freeze(missing),
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
      (observation.missing.length === 0 ||
        (stat.isDirectory() && absent(path.join(observation.ancestor, observation.missing[0]!))));
  } catch {
    return false;
  }
}

export function advanceMutationObservation(
  observation: MutationPathObservation,
  parent: MutationDirectoryObservation,
  child: MutationDirectoryObservation,
): MutationPathObservation | undefined {
  if (observation.missing.length === 0 ||
    path.join(observation.ancestor, observation.missing[0]!) !== child.path) {
    return observation;
  }
  // Only the next observed absent direct child may advance. A new deeper child,
  // redirect, or unrelated rebind invalidates the epoch on the validation below.
  if (observation.ancestor !== parent.path || observation.canonicalAncestor !== parent.realPath ||
    observation.identity.dev !== parent.dev || observation.identity.ino !== parent.ino ||
    child.realPath !== child.path || path.dirname(child.path) !== parent.path) return undefined;
  try {
    const parentStat = inspectFileIdentitySync(() => fs.lstatSync(parent.path, { bigint: true }), parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
      realpathSync.native(parent.path) !== parent.realPath) return undefined;
    const stat = inspectFileIdentitySync(() => fs.lstatSync(child.path, { bigint: true }), child);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    const next = Object.freeze({
      ...observation, ancestor: child.path, canonicalAncestor: child.realPath,
      entry: identity(stat), identity: identity(stat), missing: Object.freeze(observation.missing.slice(1)),
    });
    return mutationObservationCurrent(next) ? next : undefined;
  } catch {
    return undefined;
  }
}
