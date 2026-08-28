import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import { runPinnedWriteWindows, sameNativeIdentity } from "./native-pinned-write-windows.js";
import { assertNativeStaging, createNativeStage, type NativeStagingBinding } from "./native-staged-file.js";
import type { NativeBinding } from "./native.js";
import type { PinnedWriteParams } from "./pinned-write.js";
import { describeStagedDirectory, exactIdentityMatches } from "./staged-directory.js";

export async function runPinnedWriteNative(binding: NativeBinding, params: PinnedWriteParams): Promise<FileIdentityStat> {
  const windows = process.platform === "win32";
  if (!windows) {
    assertNativeStaging(binding);
  }
  const directoryFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0);
  const root = await fs.open(params.rootPath, directoryFlags);
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
    let rootMatches: boolean;
    if (windows) {
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
      binding.mkdirBeneath(root.fd, params.relativeParentPath, 0o777);
    }
    parentFd = binding.openBeneath(
      root.fd,
      params.relativeParentPath,
      directoryFlags,
    ).fd;
    const parentPath = await fs.realpath(
      params.relativeParentPath
        ? path.join(params.rootPath, ...params.relativeParentPath.split("/"))
        : params.rootPath,
    );
    const directory = windows ? undefined : describeStagedDirectory(parentFd, parentPath);
    if (windows) {
      const parentPathStat = await fs.lstat(parentPath);
      const parentIdentity = binding.fstatIdentity(parentFd);
      if (parentPathStat.isSymbolicLink() || !sameNativeIdentity(parentPathStat, parentIdentity)) {
        throw new FsSafeError("path-mismatch", "native write parent changed during resolution");
      }
    }
    if (params.overwrite === false) {
      try {
        await fs.lstat(path.join(parentPath, params.basename));
        throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    if (windows) {
      // Keep the released Windows leaf/parent/root close sequence and policy.
      windowsOwnsDirectories = true;
      return await runPinnedWriteWindows(binding, params, root, parentFd, parentPath);
    }
    const ownedParent = parentFd;
    parentFd = undefined;
    await using staged = await createNativeStage(
      binding as NativeStagingBinding, ownedParent, directory!, params.input, params.mode, params.maxBytes, false,
    );
    const published = await staged.publish(params.basename, { overwrite: params.overwrite !== false });
    return { dev: published.staged.identity.dev, ino: published.staged.identity.ino };
  } finally {
    if (windows && !windowsOwnsDirectories) {
      if (parentFd !== undefined) {
        fsSync.closeSync(parentFd);
      }
      await root.close().catch(() => undefined);
    }
  }
}
