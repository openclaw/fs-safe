import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { hasErrorCode } from "./file-cleanup.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";

/** Pin the published name before releasing a descriptor opened through its stage. */
export async function openPublicationHandle(targetPath: string, identity: BigIntStats) {
  const flags = resolveReadOpenFlags();
  const handle = await fs.open(targetPath, flags).catch(async error => {
    // Restrictive final modes must not be widened just to inspect publication.
    if (!hasErrorCode(error, "EACCES") || (process.arch !== "x64" && process.arch !== "arm64")) throw error;
    const metadataFlag = process.platform === "linux" ? 0x200000 : undefined; // O_PATH
    if (metadataFlag === undefined) throw error;
    return fs.open(targetPath, metadataFlag | fsSync.constants.O_NOFOLLOW);
  });
  try {
    const opened = fsSync.fstatSync(handle.fd, { bigint: true });
    const named = fsSync.lstatSync(targetPath, { bigint: true });
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() ||
      !sameFileIdentityForCleanup(opened, identity) || !sameFileIdentityForCleanup(named, identity)) {
      throw new FsSafeError("path-mismatch", "publication descriptor handoff identity changed");
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
