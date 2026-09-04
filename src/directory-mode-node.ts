import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { inspectDirectoryIdentity } from "./directory-guard.js";
import { inspectFileIdentity } from "./strict-file-identity.js";
import { assertOwnedDirectory, ownDirectoryMode, type DirectoryModeOwner } from "./directory-mode-owner.js";

function searchOnlyFlags(): { flags: number; proc: boolean } | undefined {
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
    const route = searchOnlyFlags();
    if (!route) throw error;
    proc = route.proc;
    return await fs.open(dirPath, route.flags | flags);
  });
  try {
    const inspect = async () => {
      const opened = await inspectFileIdentity(() => handle.stat({ bigint: true }), expected);
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
      const opened = await inspectFileIdentity(() => handle.stat({ bigint: true }), expected);
      const followed = await inspectFileIdentity(() => fs.stat(procPath, { bigint: true }), expected);
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
    await handle.close();
    throw error;
  }
}
