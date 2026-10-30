import fs from "node:fs";
import path from "node:path";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { finalizeCreatedDirectoryModeSync, nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import { openExactNativeRootSync } from "./native-parent-admission.js";
import { hasNodeErrorCode } from "./path.js";
import { realpathSync } from "./realpath.js";
import { assertRootIdentityCurrentSync, type RootContext } from "./root-context.js";
import { verifyMkdirDirectory } from "./root-create-native.js";
import { directoryComponentNotDirectoryError } from "./root-errors.js";
import { isSafePathSegment } from "./safe-path-segment.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
import { pathForWindowsFilesystem } from "./windows-path-alias.js";

export function tryMkdirNativeParents(root: RootContext, relativePath: string, mode?: number): boolean {
  try {
    return mkdirOrdinaryNativeParents(root, relativePath, mode);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOTDIR")) throw directoryComponentNotDirectoryError(error);
    throw error;
  }
}

function mkdirOrdinaryNativeParents(root: RootContext, relativePath: string, mode?: number): boolean {
  if (getFsSafeTestHooks()?.beforeRootFallbackMutation) return false;
  const segments = relativePath.split(path.sep === "\\" ? /[\\/]/ : "/");
  if (segments.length < 2 || segments.some(segment =>
    !isSafePathSegment(segment, { allowDotPrefix: true }) || segment.endsWith("."))) return false;
  let rootStat!: fs.BigIntStats;
  assertRootIdentityCurrentSync(root, stat => { rootStat = stat; });
  const target = path.join(root.rootReal, ...segments);
  const parentPath = path.dirname(target);
  try {
    const child = fs.lstatSync(pathForWindowsFilesystem(target), { throwIfNoEntry: false });
    if (child && (!child.isDirectory() || realpathSync.native(pathForWindowsFilesystem(target)) !== target)) return false;
  } catch { return false; }
  let parentIdentity: fs.BigIntStats;
  try {
    parentIdentity = inspectDirectoryIdentitySync(parentPath);
  } catch (error) {
    // Reuse this exact Root snapshot and failed parent observation without an
    // intervening await. All opened ancestors still receive fresh native fences.
    return hasNodeErrorCode(error, "ENOENT") ? mkdirMissingParents(root, segments, rootStat, mode) : false;
  }
  try {
    if (realpathSync.native(pathForWindowsFilesystem(parentPath)) !== parentPath) return false;
  } catch { return false; }
  return mkdirExistingParent(root, segments, parentIdentity, mode);
}

/** Ordinary missing suffixes need no policy callbacks or repeated path resolution. */
function mkdirMissingParents(root: RootContext, segments: string[], rootStat: fs.BigIntStats, mode?: number): boolean {
  const binding = getNativeBinding("openBeneath", "mkdirChildBeneath");
  if (!binding?.openBeneath || !binding.mkdirChildBeneath || (!binding.mkdirOpenChildBeneath && mode === undefined)) return false;
  let parentDepth = segments.length - 2;
  let parentPath: string;
  let parentIdentity: fs.BigIntStats;
  for (;;) {
    parentPath = path.join(root.rootReal, ...segments.slice(0, parentDepth));
    try {
      parentIdentity = inspectDirectoryIdentitySync(parentPath, undefined,
        parentDepth === 0 ? rootStat : undefined);
      if (realpathSync.native(pathForWindowsFilesystem(parentPath)) !== parentPath) return false;
      break;
    } catch (error) {
      if (!hasNodeErrorCode(error, "ENOENT") || parentDepth === 0) return false;
      parentDepth--;
    }
  }
  try {
    using rootOwner = openExactNativeRootSync(binding, {
      rootPath: root.rootReal, rootIdentity: root.rootIdentity,
    });
    const close = captureNativeFdClose(binding);
    const directories: Array<{ fd: number; pathname: string }> = [];
    using directoryOwner = { [Symbol.dispose]() {
      const errors: unknown[] = [];
      for (const directory of directories.toReversed()) {
        try { close(directory.fd); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "mkdir directory close failed");
    } };
    const flags = (mode === undefined ? nodeDirectorySearchOnlyFlags()?.flags ?? fs.constants.O_RDONLY : fs.constants.O_RDONLY) |
      (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
    let current = rootOwner.fd;
    if (parentDepth > 0) {
      current = binding.openBeneath(rootOwner.fd, segments.slice(0, parentDepth).join("/"), flags).fd;
      directories.push({ fd: current, pathname: parentPath });
      inspectFileIdentitySync(() => fs.fstatSync(current, { bigint: true }), parentIdentity);
    }
    const assertCurrent = () => {
      assertRootIdentityCurrentSync(root);
      for (const directory of directories) verifyMkdirDirectory(binding, directory.fd, directory.pathname);
      verifyMkdirDirectory(binding, rootOwner.fd, root.rootReal);
    };
    assertCurrent();
    for (const segment of segments.slice(parentDepth)) {
      const child = binding.mkdirOpenChildBeneath
        ? binding.mkdirOpenChildBeneath(current, segment, mode ?? 0o777, flags)
        : {
          created: binding.mkdirChildBeneath(current, segment, mode ?? 0o777),
          fd: binding.openBeneath(current, segment, flags).fd,
        };
      parentPath = path.join(parentPath, segment);
      directories.push({ fd: child.fd, pathname: parentPath });
      // Retain every ancestor until the complete suffix is admitted. The
      // post-create fence also precedes the next synchronous child mutation.
      assertCurrent();
      if (mode !== undefined && child.created) {
        finalizeCreatedDirectoryModeSync(child, mode);
        assertCurrent();
      }
      current = child.fd;
    }
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOTDIR")) throw directoryComponentNotDirectoryError(error);
    throw error;
  }
}

function mkdirExistingParent(root: RootContext, segments: string[], parentIdentity: fs.BigIntStats, mode?: number): boolean {
  const target = path.join(root.rootReal, ...segments);
  const parentPath = path.dirname(target);
  const binding = getNativeBinding("openBeneath", "mkdirChildBeneath");
  if (!binding?.openBeneath || !binding.mkdirChildBeneath) {
    throw new FsSafeError("helper-unavailable", "native confined creation is unavailable");
  }
  using rootOwner = openExactNativeRootSync(binding, {
    rootPath: root.rootReal, rootIdentity: root.rootIdentity,
  });
  verifyMkdirDirectory(binding, rootOwner.fd, root.rootReal);
  const flags = (mode === undefined ? nodeDirectorySearchOnlyFlags()?.flags ?? fs.constants.O_RDONLY : fs.constants.O_RDONLY) |
    (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  const close = captureNativeFdClose(binding);
  const parent = binding.openBeneath(rootOwner.fd, segments.slice(0, -1).join("/"), flags).fd;
  using parentOwner = { [Symbol.dispose]() { close(parent); } };
  inspectFileIdentitySync(() => fs.fstatSync(parent, { bigint: true }), parentIdentity);
  verifyMkdirDirectory(binding, parent, parentPath);
  assertRootIdentityCurrentSync(root);
  const name = segments.at(-1)!;
  const child = binding.mkdirOpenChildBeneath
    ? binding.mkdirOpenChildBeneath(parent, name, mode ?? 0o777, flags)
    : {
      created: binding.mkdirChildBeneath(parent, name, mode ?? 0o777),
      fd: binding.openBeneath(parent, name, flags).fd,
    };
  using childOwner = { [Symbol.dispose]() { close(child.fd); } };
  assertRootIdentityCurrentSync(root);
  verifyMkdirDirectory(binding, child.fd, target);
  inspectDirectoryIdentitySync(parentPath, parentIdentity);
  verifyMkdirDirectory(binding, parent, parentPath);
  verifyMkdirDirectory(binding, rootOwner.fd, root.rootReal);
  if (mode !== undefined && child.created) {
    finalizeCreatedDirectoryModeSync(child, mode);
    verifyMkdirDirectory(binding, child.fd, target);
    verifyMkdirDirectory(binding, parent, parentPath);
    verifyMkdirDirectory(binding, rootOwner.fd, root.rootReal);
    assertRootIdentityCurrentSync(root);
  }
  return true;
}
