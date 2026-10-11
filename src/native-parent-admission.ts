import fsSync, { type BigIntStats, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertSyncDirectoryGuard, inspectDirectoryIdentity, inspectDirectoryIdentitySync } from "./directory-guard.js";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { inspectNativeDirectoryObservation, type NativeDirectoryObservationBackend } from "./native-directory-observation.js";
import { FsSafeError } from "./errors.js";
import { hasSafeFileIdentity, type FileIdentityStat } from "./file-identity.js";
import { assertNativeCapabilities, type NativeBinding } from "./native.js";
import { captureNativeFdClose } from "./native-binding.js";
import { realpathSync } from "./realpath.js";
import { describePolicyStagedDirectory, describeStagedDirectory, exactIdentityMatches } from "./staged-directory.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem } from "./windows-path-alias.js";

type RootIdentity = Pick<FileIdentityStat, "dev" | "ino">;

type NativeRootHandle = {
  readonly fd: number;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type NativeRootAdmission = {
  directoryFlags?: number;
  exactRoot: boolean;
  reportCloseErrors?: boolean;
  operation: string;
  root: NativeRootHandle;
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
  return hasSafeFileIdentity(left) && hasSafeFileIdentity(right) &&
    BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
}

function unavailable(message: string): FsSafeError {
  return new FsSafeError("helper-unavailable", message);
}

function assertParentAdmissionAvailable(binding: NativeBinding): asserts binding is NativeBinding & Required<Pick<NativeBinding, "openBeneath">> {
  if (typeof binding.openBeneath !== "function") {
    throw unavailable("native parent directory admission is unavailable");
  }
  captureNativeFdClose(binding);
  assertNativeCapabilities(binding, "openBeneath");
}

/** Short native mutations need a retained descriptor, not a Node FileHandle. */
export function openExactNativeRootSync(
  binding: NativeBinding,
  params: { rootPath: string; rootIdentity: { dev: bigint; ino: bigint } },
): { fd: number; stat: BigIntStats; close(): void; [Symbol.dispose](): void } {
  assertParentAdmissionAvailable(binding);
  assertNoWindowsPathAlias(params.rootPath, "filesystem", "native root uses a Windows filesystem namespace alias");
  const flags = (nodeDirectorySearchOnlyFlags()?.flags ?? fsSync.constants.O_RDONLY) |
    (fsSync.constants.O_DIRECTORY ?? 0);
  const fd = fsSync.openSync(pathForWindowsFilesystem(params.rootPath), flags);
  let held = true;
  const close = () => {
    if (!held) return;
    held = false;
    fsSync.closeSync(fd);
  };
  try {
    const stat = inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true }), params.rootIdentity);
    if (!stat.isDirectory()) throw new FsSafeError("path-mismatch", "native root is not a directory");
    return { fd, stat, close, [Symbol.dispose]: close };
  } catch (error) {
    try { close(); } catch (closeError) {
      throw createSuppressedError(closeError, error, "native root admission and close failed");
    }
    throw error;
  }
}

export function openExactNativeRootAdmissionSync(
  binding: NativeBinding,
  params: { rootPath: string; rootIdentity: { dev: bigint; ino: bigint }; operation: string; reportCloseErrors?: boolean },
) {
  return {
    directoryFlags: (nodeDirectorySearchOnlyFlags()?.flags ?? fsSync.constants.O_RDONLY) | (fsSync.constants.O_DIRECTORY ?? 0),
    exactRoot: true,
    reportCloseErrors: params.reportCloseErrors,
    operation: params.operation,
    root: openExactNativeRootSync(binding, params),
    rootPath: params.rootPath,
  };
}

export function borrowNativeRootParent(
  admission: ReturnType<typeof openExactNativeRootAdmissionSync>,
): NativeParentAdmission {
  const guard = { dir: admission.rootPath, realPath: admission.rootPath, stat: admission.root.stat };
  assertSyncDirectoryGuard(guard);
  return { fd: admission.root.fd, guard, close() { /* The enclosing Root owner closes this descriptor. */ } };
}

export async function openNativeRootAdmission(
  binding: NativeBinding,
  params: { rootPath: string; rootIdentity?: RootIdentity; operation?: string; reportCloseErrors?: boolean; searchOnly?: boolean },
): Promise<NativeRootAdmission> {
  assertParentAdmissionAvailable(binding);
  const directoryFlags = (params.searchOnly ? nodeDirectorySearchOnlyFlags()?.flags ?? fsSync.constants.O_RDONLY : fsSync.constants.O_RDONLY) |
    (fsSync.constants.O_DIRECTORY ?? 0);
  assertNoWindowsPathAlias(params.rootPath, "filesystem", "native root uses a Windows filesystem namespace alias");
  let fd = fsSync.openSync(pathForWindowsFilesystem(params.rootPath), directoryFlags);
  const close = async () => {
    if (fd < 0) return;
    const owned = fd;
    fd = -1;
    fsSync.closeSync(owned);
  };
  const root: NativeRootHandle = { get fd() { return fd; }, close, [Symbol.asyncDispose]: close };
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
      const identity = fsSync.fstatSync(root.fd, { bigint: true });
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
      directoryFlags,
      exactRoot,
      reportCloseErrors: params.reportCloseErrors,
      operation: params.operation ?? "native admission",
      root,
      rootPath: params.rootPath,
    };
  } catch (error) {
    try {
      await root.close();
    } catch (closeError) {
      // Windows admission keeps the typed boundary failure primary.
      if (process.platform !== "win32" || params.reportCloseErrors) {
        throw createSuppressedError(closeError, error, "native root admission and close failed");
      }
    }
    throw error;
  }
}

export async function openNativeParentAdmission(
  binding: NativeBinding,
  rootAdmission: Omit<NativeRootAdmission, "root"> & { root: Pick<FileHandle, "fd"> },
  relativeParentPath: string,
  observation?: "native-directory",
): Promise<NativeParentAdmission> {
  assertParentAdmissionAvailable(binding);
  const closeFd = captureNativeFdClose(binding);
  const directoryFlags = rootAdmission.directoryFlags ?? (fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0));
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
    if (observation === "native-directory" && process.platform === "win32" && rootAdmission.exactRoot &&
        typeof binding.observeDirectory === "function") {
      const stat = inspectFileIdentitySync(() => fsSync.fstatSync(parentFd, { bigint: true }));
      let observed;
      try {
        observed = inspectNativeDirectoryObservation(
          binding as NativeDirectoryObservationBackend, parentInput, stat,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "OBSERVATION_UNAVAILABLE") throw error;
      }
      if (observed) {
        assertNoWindowsPathAlias(observed.realPath, "filesystem", "native parent uses a Windows filesystem namespace alias");
        inspectDirectoryIdentitySync(observed.realPath, stat, stat);
        return {
          fd: parentFd,
          close: () => closeFd(parentFd),
          guard: { dir: observed.realPath, realPath: observed.realPath, stat },
        };
      }
    }
    const parentPath = realpathSync.native(pathForWindowsFilesystem(parentInput));
    assertNoWindowsPathAlias(
      parentPath,
      "filesystem",
      "native parent uses a Windows filesystem namespace alias",
    );
    if (observation === "native-directory" && process.platform !== "win32" && rootAdmission.exactRoot) {
      const captured = describePolicyStagedDirectory(parentFd, parentPath, binding);
      captured.disposeObservation?.();
      return {
        fd: parentFd,
        close: () => closeFd(parentFd),
        guard: { dir: parentPath, realPath: parentPath, stat: captured.stat },
        stagedDirectory: captured.directory,
      };
    }
    const stagedDirectory = process.platform === "win32"
      ? undefined
      : describeStagedDirectory(parentFd, parentPath);
    const parentPathStat = rootAdmission.exactRoot
      ? await inspectDirectoryIdentity(
        parentPath,
        inspectFileIdentitySync(() => fsSync.fstatSync(parentFd, { bigint: true })),
      )
      : fsSync.lstatSync(pathForWindowsFilesystem(parentPath), { bigint: true });
    if (process.platform === "win32" && !rootAdmission.exactRoot) {
      const parentIdentity = fsSync.fstatSync(parentFd, { bigint: true });
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
      if (process.platform !== "win32" || rootAdmission.reportCloseErrors) {
        throw createSuppressedError(closeError, error, "native parent admission and close failed");
      }
    }
    throw error;
  }
}
