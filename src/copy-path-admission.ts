import fs from "node:fs";
import path from "node:path";
import { assertSyncDirectoryGuard, captureDirectoryGuard, inspectDirectoryIdentitySync, type AnyAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { realpathSync } from "./realpath.js";
import { resolveRootPathSync, ROOT_PATH_ALIAS_POLICIES } from "./root-path.js";

export type CopyPath = { rootPath: string; absolutePath: string };

function admitUncachedCopyPath(input: CopyPath, create = false) {
  if (!path.isAbsolute(input.rootPath) || !path.isAbsolute(input.absolutePath)) {
    throw new FsSafeError("invalid-path", "copy roots and paths must be absolute");
  }
  const root = captureDirectoryGuard(realpathSync(input.rootPath), "native", { bigint: true });
  const resolve = () => {
    const parent = create ? resolveRootPathSync({
      ...input, absolutePath: path.dirname(input.absolutePath), boundaryLabel: "copy parent",
      rejectSymlinks: true, rejectFinalSymlink: true,
    }) : undefined;
    const selected = resolveRootPathSync({
      ...input, boundaryLabel: "copy", rejectSymlinks: !create, rejectFinalSymlink: !create,
      policy: create ? ROOT_PATH_ALIAS_POLICIES.unlinkTarget : undefined,
    });
    if (parent && path.dirname(selected.canonicalPath) !== parent.canonicalPath) {
      throw new FsSafeError("path-mismatch", "copy destination parent changed");
    }
    return selected;
  };
  const selected = resolve();
  const parent = captureDirectoryGuard(path.dirname(selected.canonicalPath), "native", { bigint: true });
  const assertCurrent = () => {
    assertSyncDirectoryGuard(root);
    assertSyncDirectoryGuard(parent);
    const current = resolve();
    if (current.rootCanonicalPath !== root.realPath || current.canonicalPath !== selected.canonicalPath) {
      throw new FsSafeError("path-mismatch", "copy path changed during operation");
    }
    assertSyncDirectoryGuard(root);
    assertSyncDirectoryGuard(parent);
  };
  assertCurrent();
  return { path: selected.canonicalPath, parent, assertCurrent, rootCanonicalPath: undefined as string | undefined };
}

type ParentAdmission = {
  root: AnyAsyncDirectoryGuard;
  parent: AnyAsyncDirectoryGuard;
  chain: AnyAsyncDirectoryGuard[];
};

/** Metadata custody lasts only for the owning copy or explicit batch. */
export function createCopyPathAdmissionCache() {
  const roots = new Map<string, AnyAsyncDirectoryGuard>();
  const parents = new Map<string, Map<string, ParentAdmission>>();
  const directories = new Map<string, AnyAsyncDirectoryGuard>();
  const assertParent = ({ root, parent, chain }: ParentAdmission) => {
    assertSyncDirectoryGuard(root);
    for (const guard of chain) {
      inspectDirectoryIdentitySync(guard.dir, { dev: BigInt(guard.stat.dev), ino: BigInt(guard.stat.ino) });
    }
    assertSyncDirectoryGuard(parent);
    assertSyncDirectoryGuard(root);
  };
  const admit = (input: CopyPath, create = false): ReturnType<typeof admitUncachedCopyPath> => {
    // Keep the public resolver for Windows aliases and noncanonical spellings,
    // including raw dot segments whose traversal must not be normalized away.
    if (process.platform === "win32" || !path.isAbsolute(input.rootPath) ||
      !path.isAbsolute(input.absolutePath) || input.rootPath.includes("\0") || input.absolutePath.includes("\0") ||
      path.resolve(input.rootPath) !== input.rootPath || path.resolve(input.absolutePath) !== input.absolutePath ||
      !input.absolutePath.startsWith(input.rootPath.endsWith(path.sep) ? input.rootPath : `${input.rootPath}${path.sep}`)) {
      return admitUncachedCopyPath(input, create);
    }
    let root = roots.get(input.rootPath);
    if (!root) {
      const canonical = realpathSync(input.rootPath);
      if (canonical !== input.rootPath) return admitUncachedCopyPath(input, create);
      root = captureDirectoryGuard(canonical, "native", { bigint: true });
      roots.set(input.rootPath, root);
    }
    assertSyncDirectoryGuard(root);
    const parentPath = path.dirname(input.absolutePath);
    let byParent = parents.get(input.rootPath);
    let admitted = byParent?.get(parentPath);
    if (!admitted) {
      // The first file in each parent retains the existing lexical admission.
      const selected = admitUncachedCopyPath(input, create);
      const chain: AnyAsyncDirectoryGuard[] = [];
      let cursor = input.rootPath;
      const relative = path.relative(input.rootPath, parentPath);
      for (const segment of relative ? relative.split(path.sep) : []) {
        cursor = path.join(cursor, segment);
        let guard = directories.get(cursor);
        if (!guard) {
          guard = captureDirectoryGuard(cursor, "native", { bigint: true });
          directories.set(cursor, guard);
        }
        chain.push(guard);
      }
      admitted = { root, parent: chain.at(-1) ?? root, chain };
      assertParent(admitted);
      if (selected.path !== input.absolutePath || selected.parent.realPath !== parentPath ||
        !sameFileIdentity(selected.parent.stat, admitted.parent.stat)) {
        throw new FsSafeError("path-mismatch", "copy path changed during admission");
      }
      byParent ??= new Map();
      byParent.set(parentPath, admitted);
      parents.set(input.rootPath, byParent);
    }
    const selected = admitted;
    const assertCurrent = () => {
      assertParent(selected);
      // No file observation is cached. Preserve the resolver's symlink errors.
      if (!create && fs.lstatSync(input.absolutePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
        admitUncachedCopyPath(input, create);
        throw new FsSafeError("symlink", "symlink not allowed");
      }
    };
    assertCurrent();
    return { path: input.absolutePath, parent: selected.parent, assertCurrent, rootCanonicalPath: selected.root.realPath };
  };
  return { admit, clear() { roots.clear(); parents.clear(); directories.clear(); } };
}
