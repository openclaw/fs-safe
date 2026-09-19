import fs, { type BigIntStats } from "node:fs";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { nodeDarwinDirectoryMetadataFlags, nodeDirectorySearchOnlyFlags } from "./directory-mode-node.js";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

function inspector() {
  const native = getNativeBinding();
  if (typeof native?.inspectDarwinAcl !== "function") {
    throw new FsSafeError("helper-unavailable", "private Darwin creation requires native descriptor ACL inspection");
  }
  return native.inspectDarwinAcl.bind(native);
}

export function assertDarwinPrivateCreationAvailable(): void {
  if (process.platform === "darwin") inspector();
}

export function assertDarwinPrivateDirectoryMode(mode: number): void {
  if (process.platform === "darwin" && ((mode & ~process.umask()) & 0o500) === 0) {
    throw new FsSafeError("helper-unavailable", "private Darwin directory ACL inspection requires owner read or search permission");
  }
}

export function assertDarwinCreationAcl(fd: number, inheritanceTarget?: "file" | "directory"): void {
  if (process.platform !== "darwin") return;
  const inspect = inspector();
  const state = inspect(fd, inheritanceTarget)?.state;
  if (state === "present") {
    throw new FsSafeError("insecure-permissions", inheritanceTarget
      ? "private creation parent has inheritable Darwin ACL entries"
      : "private creation object has Darwin ACL entries");
  }
  if (state !== "absent" && state !== "empty") {
    throw new FsSafeError("helper-unavailable", "native Darwin ACL inspection returned incomplete facts");
  }
}

export function assertDarwinCreationDirectoryAcl(
  pathname: string, expected: BigIntStats, inheritanceTarget?: "file" | "directory",
): void {
  if (process.platform !== "darwin") return;
  assertDarwinPrivateCreationAvailable();
  let fd: number;
  try { fd = fs.openSync(pathname, nodeDarwinDirectoryMetadataFlags()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    const search = nodeDirectorySearchOnlyFlags();
    if (!search) throw error;
    try { fd = fs.openSync(pathname, search.flags | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EACCES") throw cause;
      throw new FsSafeError("helper-unavailable", "private Darwin directory ACL inspection requires owner read or search permission", { cause });
    }
  }
  try {
    const opened = inspectFileIdentitySync(() => fs.fstatSync(fd, { bigint: true }), expected);
    if (!opened.isDirectory()) throw new FsSafeError("path-mismatch", "ACL target is not the admitted directory");
    assertDarwinCreationAcl(fd, inheritanceTarget);
    inspectDirectoryIdentitySync(pathname, expected);
  } finally { fs.closeSync(fd); }
}
