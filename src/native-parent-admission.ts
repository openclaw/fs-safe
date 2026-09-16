import fsSync, { type BigIntStats, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectDirectoryIdentity } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import type { NativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import { realpathSync } from "./realpath.js";
import { describeStagedDirectory, exactIdentityMatches } from "./staged-directory.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem } from "./windows-path-alias.js";

type RootIdentity = Pick<FileIdentityStat, "dev" | "ino">;

export type NativeRootAdmission = {
  exactRoot: boolean;
  operation: string;
  root: FileHandle;
  rootPath: string;
};

export type NativeParentAdmission = {
  fd: number;
  close(): void;
  guard: { dir: string; realPath: string; stat: Stats | BigIntStats };
  stagedDirectory?: ReturnType<typeof describeStagedDirectory>;
};

export function sameNativeIdentity(
  left: RootIdentity,
  right: RootIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unavailable(message: string): FsSafeError {
  return new FsSafeError("helper-unavailable", message);
}

function assertParentAdmissionAvailable(binding: NativeBinding): void {
  if (typeof binding.openBeneath !== "function") {
    throw unavailable("native parent directory admission is unavailable");
  }
  captureNativeFdClose(binding);
}

export async function openNativeRootAdmission(
  binding: NativeBinding,
  params: { rootPath: string; rootIdentity?: RootIdentity; operation?: string },
): Promise<NativeRootAdmission> {
  assertParentAdmissionAvailable(binding);
  const directoryFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0);
  assertNoWindowsPathAlias(params.rootPath, "filesystem", "native root uses a Windows filesystem namespace alias");
  const root = await fs.open(pathForWindowsFilesystem(params.rootPath), directoryFlags);
  try {
    const exactRoot = typeof params.rootIdentity?.dev === "bigint" &&
      typeof params.rootIdentity.ino === "bigint";
    let rootMatches: boolean;
    if (exactRoot) {
      inspectFileIdentitySync(
        () => fsSync.fstatSync(root.fd, { bigint: true }),
        params.rootIdentity as { dev: bigint; ino: bigint },
      );
      rootMatches = true;
    } else if (process.platform === "win32") {
      if (typeof binding.fstatIdentity !== "function") {
        throw unavailable("native root directory identity checks are unavailable");
      }
      const identity = binding.fstatIdentity(root.fd);
      rootMatches = !params.rootIdentity || sameNativeIdentity(params.rootIdentity, identity);
    } else {
      const identity = fsSync.fstatSync(root.fd, { bigint: true });
      rootMatches = !params.rootIdentity || exactIdentityMatches(params.rootIdentity, identity);
    }
    if (!rootMatches) {
      throw new FsSafeError(
        "path-mismatch",
        `root path changed during ${params.operation ?? "native admission"}`,
      );
    }
    return {
      exactRoot,
      operation: params.operation ?? "native admission",
      root,
      rootPath: params.rootPath,
    };
  } catch (error) {
    try {
      await root.close();
    } catch (closeError) {
      // Windows admission keeps the typed boundary failure primary.
      if (process.platform !== "win32") {
        throw createSuppressedError(closeError, error, "native root admission and close failed");
      }
    }
    throw error;
  }
}

export async function openNativeParentAdmission(
  binding: NativeBinding,
  rootAdmission: NativeRootAdmission,
  relativeParentPath: string,
): Promise<NativeParentAdmission> {
  assertParentAdmissionAvailable(binding);
  const closeFd = captureNativeFdClose(binding);
  const directoryFlags = fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0);
  assertNoWindowsPathAlias(relativeParentPath, "relative", "native parent uses a Windows filesystem namespace alias");
  const opened = binding.openBeneath(
    rootAdmission.root.fd,
    relativeParentPath,
    directoryFlags,
  );
  if (!opened || !Number.isInteger(opened.fd) || opened.fd < 0) {
    throw unavailable("native parent directory admission did not provide a descriptor");
  }
  const parentFd = opened.fd;
  try {
    const parentInput = relativeParentPath
      ? path.join(rootAdmission.rootPath, ...relativeParentPath.split("/"))
      : rootAdmission.rootPath;
    const parentPath = realpathSync.native(pathForWindowsFilesystem(parentInput));
    assertNoWindowsPathAlias(
      parentPath,
      "filesystem",
      "native parent uses a Windows filesystem namespace alias",
    );
    const stagedDirectory = process.platform === "win32"
      ? undefined
      : describeStagedDirectory(parentFd, parentPath);
    const parentPathStat = rootAdmission.exactRoot
      ? await inspectDirectoryIdentity(
        parentPath,
        inspectFileIdentitySync(() => fsSync.fstatSync(parentFd, { bigint: true })),
      )
      : fsSync.lstatSync(pathForWindowsFilesystem(parentPath));
    if (process.platform === "win32" && !rootAdmission.exactRoot) {
      if (typeof binding.fstatIdentity !== "function") {
        throw unavailable("native parent directory identity checks are unavailable");
      }
      const parentIdentity = binding.fstatIdentity(parentFd);
      if (parentPathStat.isSymbolicLink() || !sameNativeIdentity(parentPathStat, parentIdentity)) {
        throw new FsSafeError("path-mismatch", `${rootAdmission.operation} parent changed during resolution`);
      }
    } else if (
      process.platform !== "win32" &&
      (parentPathStat.isSymbolicLink() || !exactIdentityMatches(parentPathStat, stagedDirectory!.identity))
    ) {
      throw new FsSafeError("path-mismatch", `${rootAdmission.operation} parent changed during resolution`);
    }
    return {
      fd: parentFd,
      close: () => closeFd(parentFd),
      guard: { dir: parentPath, realPath: parentPath, stat: parentPathStat },
      stagedDirectory,
    };
  } catch (error) {
    try {
      closeFd(parentFd);
    } catch (closeError) {
      if (process.platform !== "win32") {
        throw createSuppressedError(closeError, error, "native parent admission and close failed");
      }
    }
    throw error;
  }
}

export function closeNativeParentAdmission(admission: NativeParentAdmission | undefined): void {
  admission?.close();
}
