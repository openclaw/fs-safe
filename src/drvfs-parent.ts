import fs, { type BigIntStats } from "node:fs";
import { assertDirectoryGuard, captureDirectoryGuard, type AsyncDirectoryGuard } from "./directory-guard.js";
import { openStagedDirectory, assertStagedDirectoryCurrent } from "./staged-directory.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

/** Retained only for an explicitly enabled operation; no new default-path I/O. */
export function retainDrvfsParent(directory: string) {
  let parent: ReturnType<typeof openStagedDirectory> | undefined;
  try {
    // Resolve through the filesystem first: lexical normalization of link/..
    // can select a different directory (and therefore a different mount).
    const guard = captureDirectoryGuard(directory, "native", { bigint: true }) as AsyncDirectoryGuard<BigIntStats>;
    parent = openStagedDirectory(guard.realPath);
    const retained = parent;
    const assertCurrent = () => {
      inspectFileIdentitySync(() => fs.fstatSync(retained.fd, { bigint: true }), guard.stat);
      assertDirectoryGuard(guard, "native");
      assertStagedDirectoryCurrent(retained.receipt);
    };
    assertCurrent();
    return { fd: retained.fd, assertCurrent, close() { fs.closeSync(retained.fd); } };
  } catch {
    if (parent) try { fs.closeSync(parent.fd); } catch { /* Preserve strict fallback. */ }
    return undefined;
  }
}
