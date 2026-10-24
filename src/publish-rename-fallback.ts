import fs, { type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import type { NativeBinding } from "./native-binding.js";
import { openPublicationHandle } from "./publication-handle.js";
import { rememberCreatedTarget, type PublishFailureState } from "./publish-file-failure.js";

/** Retain the target pin while closing the source dentry, before native unlink. */
export async function publishRenameFallback(params: {
  binding: NativeBinding;
  sourceParent: { fd: number; basename: string };
  targetParent: { fd: number; basename: string };
  sourcePath: string;
  targetPath: string;
  source: FileHandle;
  identity: BigIntStats;
  failure: PublishFailureState;
}): Promise<FileHandle> {
  const { binding, sourceParent, targetParent, sourcePath, targetPath, source, identity, failure } = params;
  if (!binding.linkBeneath || !binding.removeStagedFile) {
    throw new FsSafeError("helper-unavailable", "no-replace publication needs native link and identity-bound unlink", {
      details: { capability: "rename-noreplace", fallback: "link-unlink", fallbackCapability: "linkat" },
    });
  }
  const verify = (stat: BigIntStats, links: bigint) => {
    if (!stat.isFile() || stat.isSymbolicLink() || !sameFileIdentityForCleanup(stat, identity)) {
      throw new FsSafeError("path-mismatch", "no-replace publication identity changed");
    }
    if (stat.nlink !== links) throw new FsSafeError("hardlink", "no-replace publication link count changed");
  };
  verify(fs.fstatSync(source.fd, { bigint: true }), 1n);
  verify(fs.lstatSync(sourcePath, { bigint: true }), 1n);
  try {
    binding.linkBeneath(sourceParent.fd, sourceParent.basename, targetParent.fd, targetParent.basename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new FsSafeError("already-exists", "no-replace fallback destination exists", { cause: error });
    }
    if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK", "EXDEV", "ENOSYS"].includes((error as NodeJS.ErrnoException)?.code ?? "")) {
      throw new FsSafeError("helper-unavailable", "renameat2 RENAME_NOREPLACE unavailable; linkat file publication fallback is unavailable", {
        cause: error, details: { capability: "rename-noreplace", fallback: "link-unlink", fallbackCapability: "linkat" },
      });
    }
    throw error;
  }
  failure.targetCreated = true;
  failure.preserveTarget = true;
  failure.phase = "rename-verify";
  failure.fallback = "link-unlink";
  failure.sourceRemoval = "not-attempted";
  let target: FileHandle | undefined;
  const verifyPair = () => {
    try {
      verify(fs.lstatSync(sourcePath, { bigint: true }), 2n);
      verify(fs.lstatSync(targetPath, { bigint: true }), 2n);
      if (target) verify(fs.fstatSync(target.fd, { bigint: true }), 2n);
    } catch (cause) {
      throw new FsSafeError("path-mismatch", "no-replace publication link pair changed", { cause });
    }
  };
  try {
    verifyPair();
    rememberCreatedTarget(failure, identity, "rename-verify");
    target = await openPublicationHandle(targetPath, identity);
    await source.close();
    verifyPair();
    failure.sourceRemoval = "still-linked";
    let removed: string;
    try {
      removed = binding.removeStagedFile(sourceParent.fd, sourceParent.basename, target.fd);
    } catch (error) {
      try {
        verify(fs.fstatSync(target.fd, { bigint: true }), 1n);
        verify(fs.lstatSync(targetPath, { bigint: true }), 1n);
        if (fs.lstatSync(sourcePath, { bigint: true, throwIfNoEntry: false })) throw error;
        removed = "name-absent";
      } catch {
        try { verifyPair(); } catch { failure.sourceRemoval = "unverified"; }
        const detail = failure.sourceRemoval === "still-linked" ? "source still linked" : "source removal unverified";
        throw new FsSafeError("helper-failed", `linkat file publication fallback published target; ${detail}`, { cause: error });
      }
    }
    if (removed !== "removed" && removed !== "name-absent") {
      failure.sourceRemoval = "unverified";
      throw new FsSafeError("helper-failed", "no-replace publication source removal is unverified");
    }
    failure.sourceRemoval = "removed";
    try {
      verify(fs.fstatSync(target.fd, { bigint: true }), 1n);
      verify(fs.lstatSync(targetPath, { bigint: true }), 1n);
    } catch (cause) {
      throw new FsSafeError("helper-failed", "no-replace publication target verification failed", { cause });
    }
    return target;
  } catch (error) {
    await target?.close().catch(() => undefined);
    throw error;
  }
}
