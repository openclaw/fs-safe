import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectDirectoryIdentity } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import { runPinnedWriteWindows, sameNativeIdentity } from "./native-pinned-write-windows.js";
import { assertNativeStaging, writeNativeStage, type NativeStagingBinding } from "./native-staged-file.js";
import type { NativeBinding } from "./native.js";
import type { PinnedWriteParams } from "./pinned-write.js";
import { describeStagedDirectory, exactIdentityMatches } from "./staged-directory.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { realpathSync } from "./realpath.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem } from "./windows-path-alias.js";

export async function runPinnedWriteNative(binding: NativeBinding, params: PinnedWriteParams): Promise<FileIdentityStat> {
  const windows = process.platform === "win32";
  if (!windows) {
    assertNativeStaging(binding);
  }
  const directoryFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0);
  const root = await fs.open(pathForWindowsFilesystem(params.rootPath), directoryFlags);
  await using posixRoot = windows ? undefined : root;
  let parentFd: number | undefined;
  let windowsOwnsDirectories = false;
  // Until stage construction takes ownership, even admission failures must close
  // the raw POSIX parent. Disposal preserves both admission and close failures.
  using parentGuard = {
    [Symbol.dispose]() {
      if (!windows && parentFd !== undefined) {
        fsSync.closeSync(parentFd);
      }
    },
  };
  try {
    const exactRoot = typeof params.rootIdentity?.dev === "bigint" && typeof params.rootIdentity.ino === "bigint"
      ? { dev: params.rootIdentity.dev, ino: params.rootIdentity.ino } : undefined;
    let rootMatches: boolean;
    if (exactRoot) {
      inspectFileIdentitySync(() => fsSync.fstatSync(root.fd, { bigint: true }), exactRoot);
      rootMatches = true;
    } else if (windows) {
      const identity = binding.fstatIdentity(root.fd);
      rootMatches = !params.rootIdentity || sameNativeIdentity(params.rootIdentity, identity);
    } else {
      const identity = fsSync.fstatSync(root.fd, { bigint: true });
      rootMatches = !params.rootIdentity || exactIdentityMatches(params.rootIdentity, identity);
    }
    if (!rootMatches) {
      throw new FsSafeError("path-mismatch", "root path changed during native write");
    }
    if (params.mkdir) {
      params.assertBeforeMutation?.();
      binding.mkdirBeneath(root.fd, params.relativeParentPath, 0o777);
    }
    parentFd = binding.openBeneath(
      root.fd,
      params.relativeParentPath,
      directoryFlags,
    ).fd;
    const parentInput =
      params.relativeParentPath
        ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
        : params.rootPath;
    const parentPath = realpathSync.native(pathForWindowsFilesystem(parentInput));
    assertNoWindowsPathAlias(
      parentPath,
      "filesystem",
      "native write parent uses a Windows filesystem namespace alias",
    );
    const directory = windows ? undefined : describeStagedDirectory(parentFd, parentPath);
    const parentPathStat = exactRoot
      ? await inspectDirectoryIdentity(parentPath, inspectFileIdentitySync(() => fsSync.fstatSync(parentFd!, { bigint: true })))
      : fsSync.lstatSync(pathForWindowsFilesystem(parentPath));
    if (windows && !exactRoot) {
      const parentIdentity = binding.fstatIdentity(parentFd);
      if (parentPathStat.isSymbolicLink() || !sameNativeIdentity(parentPathStat, parentIdentity)) {
        throw new FsSafeError("path-mismatch", "native write parent changed during resolution");
      }
    } else if (!windows && (parentPathStat.isSymbolicLink() || !exactIdentityMatches(parentPathStat, directory!.identity))) {
      throw new FsSafeError("path-mismatch", "native write parent changed during resolution");
    }
    const verificationGuard = { dir: parentPath, realPath: parentPath, stat: parentPathStat };
    if (params.overwrite === false) {
      try {
        fsSync.lstatSync(path.join(parentPath, params.basename));
        throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    if (windows) {
      // The Windows leaf owns both directories after admission.
      windowsOwnsDirectories = true;
      return await runPinnedWriteWindows(binding, params, root, parentFd, verificationGuard);
    }
    const ownedParent = parentFd;
    parentFd = undefined;
    return await writeNativeStage(
      binding as NativeStagingBinding, ownedParent, directory!, params, verificationGuard,
    );
  } finally {
    if (windows && !windowsOwnsDirectories) {
      if (parentFd !== undefined) {
        // Match the Windows leaf cleanup contract: an admission or identity
        // failure remains primary, while every owned directory is still given
        // a close attempt. In particular, a parent close failure must not skip
        // the root FileHandle close.
        try {
          fsSync.closeSync(parentFd);
        } catch {
          // Best effort while propagating the operation failure.
        }
      }
      await root.close().catch(() => undefined);
    }
  }
}
