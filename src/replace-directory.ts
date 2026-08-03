import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { guardedRename, guardedRm } from "./guarded-mutation.js";
import { assertSafePathPrefix } from "./safe-path-segment.js";
import { serializePathWrite } from "./write-queue.js";

export type ReplaceDirectoryAtomicOptions = {
  stagedDir: string;
  targetDir: string;
  backupPrefix?: string;
};

export async function replaceDirectoryAtomic(
  options: ReplaceDirectoryAtomicOptions,
): Promise<void> {
  const targetDir = path.resolve(options.targetDir);
  await serializePathWrite(targetDir, async () => {
    await replaceDirectoryAtomicUnserialized(options, targetDir);
  });
}

async function replaceDirectoryAtomicUnserialized(
  options: ReplaceDirectoryAtomicOptions,
  targetDir: string,
): Promise<void> {
  const stagedDir = path.resolve(options.stagedDir);
  const parentDir = path.dirname(targetDir);
  const backupPrefix = assertSafePathPrefix(
    options.backupPrefix ?? ".fs-safe-dir-backup-",
    { label: "atomic directory backup prefix" },
  );
  const backupDir = path.join(
    parentDir,
    `${backupPrefix}${process.pid}-${randomUUID()}`,
  );
  let backupCreated = false;

  await fs.mkdir(parentDir, { recursive: true });
  try {
    await guardedRename({ from: targetDir, to: backupDir });
    backupCreated = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  try {
    await guardedRename({ from: stagedDir, to: targetDir });
  } catch (err) {
    if (backupCreated) {
      await guardedRename({ from: backupDir, to: targetDir }).catch(() => undefined);
      backupCreated = false;
    }
    throw err;
  }

  if (backupCreated) {
    await guardedRm({ target: backupDir, recursive: true, force: true, verifyAfter: false });
  }
}
