import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { guardedRename, guardedRm } from "./guarded-mutation.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { assertSafePathPrefix } from "./safe-path-segment.js";
import { admitStandalonePublicationPath } from "./standalone-publication-path.js";
import { serializePathWrite } from "./write-queue.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";

export type ReplaceDirectoryAtomicOptions = {
  stagedDir: string;
  targetDir: string;
  backupPrefix?: string;
};

export async function replaceDirectoryAtomic(
  options: ReplaceDirectoryAtomicOptions,
): Promise<void> {
  const stagedDirInput = admitStandalonePublicationPath(
    options.stagedDir,
    "staged directory uses a Windows filesystem namespace alias",
  );
  const targetDirInput = admitStandalonePublicationPath(
    options.targetDir,
    "target directory uses a Windows filesystem namespace alias",
  );
  const stagedDir = path.resolve(stagedDirInput);
  const targetDir = path.resolve(targetDirInput);
  assertNoWindowsPathAlias(stagedDir, "filesystem", "staged directory uses a Windows filesystem namespace alias");
  assertNoWindowsPathAlias(targetDir, "filesystem", "target directory uses a Windows filesystem namespace alias");
  const backupPrefixInput = options.backupPrefix;
  await serializePathWrite(targetDir, async () => {
    await replaceDirectoryAtomicUnserialized(stagedDir, targetDir, backupPrefixInput);
  });
}

async function replaceDirectoryAtomicUnserialized(
  stagedDir: string,
  targetDir: string,
  backupPrefixInput: string | undefined,
): Promise<void> {
  const parentDir = path.dirname(targetDir);
  const backupPrefix = assertSafePathPrefix(
    backupPrefixInput ?? ".fs-safe-dir-backup-",
    { label: "atomic directory backup prefix" },
  );
  const backupDir = path.join(
    parentDir,
    `${backupPrefix}${process.pid}-${randomUUID()}`,
  );
  let backupCreated = false;

  await fs.mkdir(recursiveMkdirPath(parentDir), { recursive: true });
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
