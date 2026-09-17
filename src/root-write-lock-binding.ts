import fs from "node:fs";
import path from "node:path";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { hasNodeErrorCode, isNotFoundPathError } from "./path.js";
import { admitPathInsideRoot, type RootBoundaryIdentity } from "./root-boundary.js";
import { realpathSync } from "./realpath.js";

const lockObservations = new WeakMap<() => void, Readonly<{ rootPath: string; targetPath: string }>>();

export function canReuseParentWithMutationAssertion(
  assertion: (() => void) | undefined,
  rootPath: string,
  targetPath: string,
): boolean {
  if (assertion === undefined) return true;
  const binding = lockObservations.get(assertion);
  return binding?.rootPath === rootPath && binding.targetPath === targetPath;
}

function unsupportedSpelling(): FsSafeError {
  return new FsSafeError("path-alias", "Windows compatibility writes require lower-case ASCII destination components");
}

type MissingDestinationHint = Readonly<{
  parentPath: string;
  parts: readonly string[];
  nextIndex: number;
}>;

type EffectiveDestination = Readonly<{
  path: string;
  missing?: MissingDestinationHint;
}>;

// Missing names have no portable case/Unicode lock key. Keep this admission
// narrower than general Root paths and never change keys after acquisition.
function effectiveDestination(
  rootPath: string,
  targetPath: string,
  rootIdentity?: RootBoundaryIdentity,
): EffectiveDestination {
  let effective: string;
  let missingHint: MissingDestinationHint | undefined;
  try {
    effective = realpathSync.native(targetPath);
  } catch (error) {
    if (!isNotFoundPathError(error)) throw error;
    let cursor = targetPath;
    const missing: string[] = [];
    for (;;) {
      try {
        fs.lstatSync(cursor);
        break;
      } catch (error) {
        if (!isNotFoundPathError(error) || cursor === rootPath) throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        missing.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
    // Existing dangling links must fail resolution, not become missing names.
    const canonicalParent = realpathSync.native(cursor);
    effective = path.join(canonicalParent, ...missing);
    // The hint must describe the selected route exactly. The full resolver can
    // normalize a missing raw `..` component out of the eventual lock path.
    if (missing.length > 1 && path.resolve(canonicalParent) === canonicalParent &&
      missing.every(component => /^[a-z0-9._-]+$/.test(component) &&
        component !== "." && component !== ".." && !component.endsWith("."))) {
      missingHint = Object.freeze({ parentPath: canonicalParent, parts: Object.freeze(missing), nextIndex: 0 });
    }
  }
  const admitted = admitPathInsideRoot({ rootPath, candidatePath: effective, rootIdentity });
  if (!admitted) throw unsupportedSpelling();
  const relative = admitted.relativePath;
  if (!relative || !relative.split(path.sep).every(component =>
    /^[a-z0-9._-]+$/.test(component) && !component.endsWith("."))) throw unsupportedSpelling();
  return {
    path: admitted.path,
    // Case-folded or rebased root spellings keep the full resolver and its
    // existing root-identity admission at every mutation.
    missing: admitted.admission === "exact" && admitted.path === effective ? missingHint : undefined,
  };
}

// The hint stores only a location. Each call freshly binds the nearest existing
// prefix and its first absent child; no identity or authorization crosses calls.
function observeMissingDestination(hint: MissingDestinationHint): MissingDestinationHint | undefined {
  // A complete parent needs only the ordinary leaf check, not a prefix fence.
  if (hint.parts.length - hint.nextIndex < 2) return undefined;
  try {
    let parentPath = hint.parentPath;
    let parent = inspectDirectoryIdentitySync(parentPath);
    for (let nextIndex = hint.nextIndex; nextIndex < hint.parts.length; nextIndex++) {
      const childPath = path.join(parentPath, hint.parts[nextIndex]!);
      let child: fs.BigIntStats;
      try {
        child = fs.lstatSync(childPath, { bigint: true });
      } catch (error) {
        if (!hasNodeErrorCode(error, "ENOENT")) return undefined;
        if (realpathSync.native(parentPath) !== parentPath) return undefined;
        inspectDirectoryIdentitySync(parentPath, parent);
        try {
          fs.lstatSync(childPath);
        } catch (error) {
          if (!hasNodeErrorCode(error, "ENOENT")) return undefined;
          // Absence can follow a renamed ancestor through a new alias while
          // preserving the directory's identity. Finish at its current name.
          if (realpathSync.native(parentPath) !== parentPath) return undefined;
          return Object.freeze({ parentPath, parts: hint.parts, nextIndex });
        }
        return undefined;
      }
      // An existing leaf always receives the historical full resolution,
      // including final links, collisions and unsupported canonical spellings.
      if (nextIndex === hint.parts.length - 1) return undefined;
      parent = inspectDirectoryIdentitySync(childPath, undefined, child);
      parentPath = childPath;
    }
  } catch {
    // Removal, redirection and uncertain observations only discard the hint.
    // The full resolver below still determines the destination and error.
  }
  return undefined;
}

export function assertRootFallbackWritePath(expected: string | undefined, actual: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new FsSafeError("path-mismatch", "compatibility write destination changed after lock selection");
  }
}

export function createRootWriteLockBinding(params: Readonly<{
  rootPath: string;
  targetPath: string;
  rootIdentity?: RootBoundaryIdentity;
}>) {
  const { rootPath } = params;
  const rootIdentity = params.rootIdentity && Object.freeze({
    dev: params.rootIdentity.dev, ino: params.rootIdentity.ino,
  });
  const selected = effectiveDestination(rootPath, params.targetPath, rootIdentity);
  const targetPath = selected.path;
  let missingHint = selected.missing;
  const relativePath = path.relative(rootPath, targetPath);
  let active = true;
  const assertCurrent = () => {
    if (!active) throw new FsSafeError("path-mismatch", "compatibility lock observation expired");
    const observed = missingHint && observeMissingDestination(missingHint);
    if (observed) {
      missingHint = observed;
      return;
    }
    missingHint = undefined;
    const current = effectiveDestination(rootPath, targetPath, rootIdentity);
    assertRootFallbackWritePath(targetPath, current.path);
    missingHint = current.missing;
  };
  // Only this library-owned, observation-only closure permits parent reuse.
  // Callers cannot obtain that status by setting properties on their callback.
  lockObservations.set(assertCurrent, Object.freeze({ rootPath, targetPath }));
  return Object.freeze({
    targetPath,
    relativePath,
    // The existing lock protocol uses slashes; the writer needs native spelling.
    relativeLockPath: relativePath.split(path.sep).join("/"),
    assertCurrent,
    dispose() {
      active = false;
      missingHint = undefined;
      lockObservations.delete(assertCurrent);
    },
  });
}
