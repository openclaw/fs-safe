import fsSync, { constants, type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { inspectDirectoryIdentity, inspectDirectoryIdentitySync } from "./directory-guard.js";
import { inspectFileIdentity, inspectFileIdentitySync } from "./strict-file-identity.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";

export type DirectoryModeChecks = {
  check?: () => void;
  beforeChmod?: () => Promise<void>;
};
export type DirectoryModeOwner = {
  verify(check?: () => void): Promise<void>;
  apply(mode: number, checks?: DirectoryModeChecks): Promise<void>;
  close(): Promise<void>;
};

export function assertOwnedDirectory(expected: Stats | BigIntStats, actual: Stats | BigIntStats): void {
  if (actual.isSymbolicLink() || !actual.isDirectory()) {
    throw new FsSafeError("not-file", "directory mode target must be a real directory");
  }
  if (!sameFileIdentityForCleanup(expected, actual)) {
    throw new FsSafeError("path-mismatch", "directory changed before its mode could be applied");
  }
}

/** Serializes use and close: even a queued path-based fd operation retains its descriptor. */
export function ownDirectoryMode(params: {
  inspect: () => Promise<number>;
  chmod: (mode: number) => Promise<void>;
  prepareChmod?: () => Promise<void>;
  verifyChmod?: () => Promise<void>;
  close: () => Promise<void>;
  ignoreChmodError?: boolean;
}): DirectoryModeOwner {
  let pending = Promise.resolve();
  let closing: Promise<void> | undefined;
  const enqueue = (run: () => Promise<void>): Promise<void> => {
    if (closing) return Promise.reject(new FsSafeError("path-mismatch", "directory mode owner is closed"));
    const operation = pending.then(run);
    pending = operation.catch(() => undefined);
    return operation;
  };
  return {
    verify: (check) => enqueue(async () => {
      check?.();
      await params.inspect();
      check?.();
    }),
    apply: (mode, checks = {}) => enqueue(async () => {
      // inspect() reports permission bits only; chmod ignores file-type bits,
      // so tolerate raw stat modes (e.g. S_IFDIR | 0o755) by masking up front.
      mode &= 0o7777;
      checks.check?.();
      const currentMode = await params.inspect();
      checks.check?.();
      if (currentMode === mode && !checks.beforeChmod && !checks.check) return;
      if (currentMode !== mode) {
        await params.prepareChmod?.();
        checks.check?.();
      }
      await checks.beforeChmod?.();
      checks.check?.();
      // Hooks/ancestor checks can yield; recheck the original named association.
      await params.inspect();
      checks.check?.();
      let dispatchDeadlineFailure: { error: unknown } | undefined;
      if (currentMode !== mode) {
        checks.check?.();
        try {
          await params.chmod(mode);
        } catch (error) {
          if (!params.ignoreChmodError) throw error;
        }
        // Expiry cannot release the fd while post-dispatch verification is pending.
        try { checks.check?.(); } catch (error) { dispatchDeadlineFailure = { error }; }
        await params.verifyChmod?.();
      }
      const finalMode = await params.inspect();
      if (dispatchDeadlineFailure) throw dispatchDeadlineFailure.error;
      checks.check?.();
      if (!params.ignoreChmodError && finalMode !== mode) {
        throw new FsSafeError("path-mismatch", "directory final mode could not be verified");
      }
    }),
    close() {
      closing ??= pending.then(params.close);
      return closing;
    },
  };
}

/** Darwin descriptor inspection avoids requesting directory-content reads. */
export function nodeDarwinDirectoryMetadataFlags(): number {
  if (process.platform !== "darwin" || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new FsSafeError("helper-unavailable", "Darwin directory metadata descriptors are unavailable");
  }
  // Darwin SDK O_EVTONLY; Node omits this flag from its exported constants.
  return 0x8000 | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

export function nodeDirectorySearchOnlyFlags(): { flags: number; proc: boolean } | undefined {
  if (process.arch !== "x64" && process.arch !== "arm64") return undefined;
  // Darwin SDK O_SEARCH = O_EXEC (0x40000000) | O_DIRECTORY, on x64/arm64.
  if (process.platform === "darwin") return { flags: 0x40000000, proc: false };
  // Linux x86-64/aarch64 UAPI O_PATH = 010000000. Not a usable fchmod fd.
  if (process.platform === "linux") return { flags: 0x200000, proc: true };
  return undefined;
}

/** Real Node only: injected filesystem adapters must retain descriptor-chmod semantics. */
export async function pinNodeDirectoryForMode(
  dirPath: string,
  options: { expectedIdentity?: BigIntStats; ownerUid?: number } = {},
): Promise<DirectoryModeOwner> {
  const { ownerUid } = options;
  const assertOwner = (stat: BigIntStats) => {
    if (ownerUid !== undefined && stat.uid !== BigInt(ownerUid)) {
      throw new FsSafeError("not-owned", "directory mode target must retain its expected owner");
    }
  };
  const expected = await inspectDirectoryIdentity(dirPath, options.expectedIdentity);
  assertOwner(expected);
  if (process.platform === "win32") {
    // POSIX mode enforcement is unsupported; retain strict path identity checks.
    return ownDirectoryMode({
      inspect: async () => { assertOwner(await inspectDirectoryIdentity(dirPath, expected)); return 0; },
      chmod: async () => undefined, close: async () => undefined, ignoreChmodError: true,
    });
  }
  if ([constants.O_DIRECTORY, constants.O_NOFOLLOW, constants.O_NONBLOCK, constants.O_RDONLY]
    .some((flag) => typeof flag !== "number")) {
    throw new FsSafeError("helper-unavailable", "no-follow directory mode descriptors are unavailable");
  }
  const flags = constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let proc = false;
  const handle = await fs.open(dirPath, constants.O_RDONLY | flags).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EACCES") throw error;
    const route = nodeDirectorySearchOnlyFlags();
    if (!route) throw error;
    proc = route.proc;
    return await fs.open(dirPath, route.flags | flags);
  });
  try {
    const inspect = async () => {
      const opened = await inspectFileIdentity(() => fsSync.fstatSync(handle.fd, { bigint: true }), expected);
      assertOwnedDirectory(expected, opened);
      assertOwner(opened);
      await inspectDirectoryIdentity(dirPath, expected);
      return Number(opened.mode & 0o7777n);
    };
    const procPath = `/proc/self/fd/${handle.fd}`;
    const assertProcAuthority = async () => {
      // Authenticate the fd namespace, not the followed target's filesystem.
      // This trusts host mount-namespace integrity, not privileged mount replacement.
      const namespace = await fs.statfs("/proc/self/fd", { bigint: true });
      if (namespace.type !== 0x9fa0n) {
        throw new FsSafeError("path-mismatch", "directory mode requires a trusted procfs fd namespace");
      }
      const opened = await inspectFileIdentity(() => fsSync.fstatSync(handle.fd, { bigint: true }), expected);
      const followed = await inspectFileIdentity(() => fsSync.statSync(procPath, { bigint: true }), expected);
      assertOwnedDirectory(opened, followed);
      assertOwner(opened);
      assertOwner(followed);
    };
    const owner = ownDirectoryMode({
      inspect,
      prepareChmod: proc ? assertProcAuthority : undefined,
      verifyChmod: proc ? assertProcAuthority : undefined,
      async chmod(mode) {
        if (proc) {
          await fs.chmod(procPath, mode);
        } else {
          await handle.chmod(mode);
        }
      },
      close: () => handle.close(),
    });
    await owner.verify();
    return owner;
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // Preserve the initial admission failure before ownership transfers.
    }
    throw error;
  }
}

/** Synchronous counterpart with the same no-follow, identity, and owner checks. */
export function pinNodeDirectoryForModeSync(
  dirPath: string,
  options: { expectedIdentity?: BigIntStats; ownerUid?: number } = {},
): { apply(mode: number, check?: () => void): void; close(): void } {
  const expected = inspectDirectoryIdentitySync(dirPath, options.expectedIdentity);
  const assertOwner = (stat: BigIntStats) => {
    if (options.ownerUid !== undefined && stat.uid !== BigInt(options.ownerUid)) {
      throw new FsSafeError("not-owned", "directory mode target must retain its expected owner");
    }
  };
  assertOwner(expected);
  if (process.platform === "win32") {
    return {
      apply: (_mode, check) => {
        check?.();
        assertOwner(inspectDirectoryIdentitySync(dirPath, expected));
        check?.();
      },
      close: () => undefined,
    };
  }
  if ([constants.O_DIRECTORY, constants.O_NOFOLLOW, constants.O_NONBLOCK, constants.O_RDONLY]
    .some((flag) => typeof flag !== "number")) {
    throw new FsSafeError("helper-unavailable", "no-follow directory mode descriptors are unavailable");
  }
  const flags = constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let fd: number;
  let proc = false;
  try {
    fd = fsSync.openSync(dirPath, constants.O_RDONLY | flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    const route = nodeDirectorySearchOnlyFlags();
    if (!route) throw error;
    proc = route.proc;
    fd = fsSync.openSync(dirPath, route.flags | flags);
  }
  let closed = false;
  const inspect = () => {
    if (closed) throw new FsSafeError("path-mismatch", "directory mode descriptor is closed");
    const stat = inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true }), expected);
    assertOwnedDirectory(expected, stat);
    assertOwner(stat);
    inspectDirectoryIdentitySync(dirPath, expected);
    return Number(stat.mode & 0o7777n);
  };
  const procPath = `/proc/self/fd/${fd}`;
  const assertProcAuthority = () => {
    if (fsSync.statfsSync("/proc/self/fd", { bigint: true }).type !== 0x9fa0n) {
      throw new FsSafeError("path-mismatch", "directory mode requires a trusted procfs fd namespace");
    }
    const opened = inspectFileIdentitySync(() => fsSync.fstatSync(fd, { bigint: true }), expected);
    const followed = inspectFileIdentitySync(() => fsSync.statSync(procPath, { bigint: true }), expected);
    assertOwnedDirectory(opened, followed);
    assertOwner(opened);
    assertOwner(followed);
  };
  try {
    inspect();
    return {
      apply: (mode, check) => {
        mode &= 0o7777;
        check?.();
        const currentMode = inspect();
        check?.();
        if (currentMode !== mode) {
          if (proc) assertProcAuthority();
          check?.();
          inspect();
          if (proc) fsSync.chmodSync(procPath, mode);
          else fsSync.fchmodSync(fd, mode);
          if (proc) assertProcAuthority();
        }
        const finalMode = inspect();
        check?.();
        if (finalMode !== mode) {
          throw new FsSafeError("path-mismatch", "directory final mode could not be verified");
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        fsSync.closeSync(fd);
      },
    };
  } catch (error) {
    try {
      fsSync.closeSync(fd);
    } catch {
      // Preserve the initial admission failure before ownership transfers.
    }
    throw error;
  }
}
