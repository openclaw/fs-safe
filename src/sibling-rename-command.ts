import fs, { type BigIntStats } from "node:fs";
import { renameDarwinNoReplace } from "./darwin-move-command.js";
import { nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import { openLinuxRenameParentSync, renameLinuxNoReplaceSync } from "./linux-rename-command.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import { moveWindowsFileNoReplaceSync } from "./windows-move-command.js";

type Identity = Pick<BigIntStats, "dev" | "ino">;

export function openSiblingRenameParentSync(parentPath: string, identity: Identity): number | undefined {
  if (process.platform === "win32") return undefined;
  if (process.platform === "linux") return openLinuxRenameParentSync(parentPath, identity);
  if (process.platform !== "darwin") {
    throw new FsSafeError("helper-unavailable", "atomic sibling publication is unavailable on this platform", {
      details: { commit: "not-attempted" },
    });
  }
  const access = nodeDirectorySearchOnlyFlags()?.flags ?? fs.constants.O_RDONLY;
  const fd = fs.openSync(parentPath, access | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    inspectFileIdentitySync(() => {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isDirectory()) throw new FsSafeError("path-mismatch", "publication parent changed");
      return stat;
    }, identity);
    return fd;
  } catch (error) {
    try { fs.closeSync(fd); } catch (closeError) {
      throw createSuppressedError(closeError, error, "publication parent admission and close failed");
    }
    throw error;
  }
}

/** Borrowed descriptors stay owned by the caller through outcome settlement. */
export function renameSiblingNoReplaceSync(input: {
  parent: { path: string; identity: Identity; fd?: number };
  source: { basename: string; identity: Identity; fd: number; links: bigint };
  targetBasename: string;
}): void {
  const { parent, source, targetBasename } = input;
  if (process.platform === "win32") {
    moveWindowsFileNoReplaceSync({
      source: { parentPath: parent.path, parentIdentity: parent.identity, basename: source.basename,
        identity: source.identity, expectedLinks: source.links },
      target: { parentPath: parent.path, parentIdentity: parent.identity, basename: targetBasename },
    });
  } else if (parent.fd !== undefined && process.platform === "linux") {
    renameLinuxNoReplaceSync({
      source: { parentFd: parent.fd, parentIdentity: parent.identity, ...source },
      target: { parentFd: parent.fd, parentIdentity: parent.identity, basename: targetBasename },
    });
  } else if (parent.fd !== undefined && process.platform === "darwin") {
    renameDarwinNoReplace({
      source: { parentFd: parent.fd, basename: source.basename },
      target: { parentFd: parent.fd, basename: targetBasename },
    });
  } else {
    throw new FsSafeError("helper-unavailable", "atomic sibling publication has no supported parent handle", {
      details: { commit: "not-attempted" },
    });
  }
}
