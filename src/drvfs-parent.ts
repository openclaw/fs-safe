import fs from "node:fs";
import { openStagedDirectory, assertStagedDirectoryCurrent } from "./staged-directory.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";

/** Retained only for an explicitly enabled operation; no new default-path I/O. */
export function retainDrvfsParent(directory: string) {
  let parent: ReturnType<typeof openStagedDirectory>;
  try { parent = openStagedDirectory(directory); }
  catch { return undefined; }
  return {
    fd: parent.fd,
    assertCurrent() {
      inspectFileIdentitySync(() => fs.fstatSync(parent.fd, { bigint: true }), parent.receipt.identity);
      assertStagedDirectoryCurrent(parent.receipt);
    },
    close() { fs.closeSync(parent.fd); },
  };
}
