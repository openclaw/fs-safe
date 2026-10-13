import fs from "node:fs";
import path from "node:path";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
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

/** Ordinary missing suffixes need no policy callbacks or repeated path resolution. */
export function tryMkdirNativeMissingParents(root: RootContext, relativePath: string): boolean {
  if (getFsSafeTestHooks()?.beforeRootFallbackMutation) return false;
  const segments = relativePath.split(path.sep === "\\" ? /[\\/]/ : "/");
  if (segments.length < 2 || segments.some(segment =>
    !isSafePathSegment(segment, { allowDotPrefix: true }) || segment.endsWith("."))) return false;
  const binding = getNativeBinding("openBeneath", "mkdirChildBeneath");
  if (!binding?.openBeneath || !binding.mkdirOpenChildBeneath) return false;
  let rootStat!: fs.BigIntStats;
  assertRootIdentityCurrentSync(root, stat => { rootStat = stat; });
  let parentDepth = segments.length - 1;
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
  // Existing immediate parents already have their own qualified path.
  if (parentDepth === segments.length - 1) return false;
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
    const flags = (nodeDirectorySearchOnlyFlags()?.flags ?? fs.constants.O_RDONLY) |
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
      const child = binding.mkdirOpenChildBeneath(current, segment, 0o777, flags);
      parentPath = path.join(parentPath, segment);
      directories.push({ fd: child.fd, pathname: parentPath });
      // Retain every ancestor until the complete suffix is admitted. The
      // post-create fence also precedes the next synchronous child mutation.
      assertCurrent();
      current = child.fd;
    }
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOTDIR")) throw directoryComponentNotDirectoryError(error);
    throw error;
  }
}
