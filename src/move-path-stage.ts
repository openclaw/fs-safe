import fsSync, { type BigIntStats } from "node:fs";
import path from "node:path";
import { createAsyncDirectoryGuard } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { guardedRm, guardedRmSync } from "./guarded-mutation.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { registerTempPathForExit, type TempPathRegistration } from "./temp-cleanup.js";

export async function createMoveStageOwner(staged: string) {
  const parent = await createAsyncDirectoryGuard(path.dirname(staged), { bigint: true });
  let identity: BigIntStats | undefined;
  let unregister: TempPathRegistration | undefined;
  const changed = () => new FsSafeError("path-mismatch", "move staging path changed before publication");
  const assertParent = (): void => {
    const current = fsSync.lstatSync(parent.dir, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() ||
      !sameFileIdentityForCleanup(current, parent.stat) ||
      fsSync.realpathSync.native(parent.dir) !== parent.realPath) throw changed();
  };
  const assertCurrent = (): void => {
    assertParent();
    if (!identity || !sameFileIdentityForCleanup(fsSync.lstatSync(staged, { bigint: true }), identity)) {
      throw changed();
    }
  };
  return {
    record(created: BigIntStats): void {
      if (!sameFileIdentityForCleanup(created, created)) throw changed();
      identity = created;
      unregister = registerTempPathForExit(staged, {
        identity,
        cleanupSync: () => {
          guardedRmSync({ target: staged, recursive: created.isDirectory(), assertBeforeMutation: assertCurrent });
        },
      });
    },
    assertCurrent,
    published(): void { unregister?.(); },
    async cleanup(): Promise<void> {
      if (!identity) return;
      try {
        await guardedRm({ target: staged, recursive: identity.isDirectory(), assertBeforeMutation: assertCurrent });
        unregister?.();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof FsSafeError) {
          unregister?.();
        }
        // Retry only the original receipt after transient cleanup I/O failures.
      }
    },
  };
}
