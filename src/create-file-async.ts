import { randomUUID } from "node:crypto";
import fsSync, { type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createDirectoryWithReceipt, type CreationDirectoryReceipt } from "./create-directory.js";
import { assertDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import {
  assertCreationFile,
  creationPublicationAfterFailure,
  privateFileSettlementFailure,
  rethrowPrivateStageCreationFailure,
  removeRecordedCreationFile,
  type CreationPublicationStatus,
} from "./creation-file-state.js";
import { inspectCreationDirectory, protectCreatedFile, verifyCreatedFile } from "./creation-permissions.js";
import { creationCollision, removeCreationDirectoryAsync, type CreationPath } from "./creation-path.js";
import { handoffCreatedFile } from "./private-producer-handoff.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { hasUnsettledWindowsSecurityCommand } from "./windows-security-command.js";

export async function createPrivateWindowsFileHandle(
  selected: CreationPath,
  options: { mode: number; assertBeforeMutation?: () => void },
): Promise<FileHandle> {
  const assertion = options.assertBeforeMutation;
  const existing = await fs.lstat(selected.target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  selected.assertParent();
  if (existing) throw new FsSafeError("already-exists", "creation target already exists");
  const parentIdentity = await inspectCreationDirectory(selected.parent.dir, false);
  selected.assertParent();
  const stageDirectory = path.join(selected.parent.dir, `.fs-safe-create-${randomUUID()}`);
  let stage: CreationDirectoryReceipt;
  try {
    stage = await createDirectoryWithReceipt(stageDirectory, { private: true, assertBeforeMutation: assertion }, {
      expectedParentIdentity: selected.parent.stat,
    });
  } catch (error) {
    rethrowPrivateStageCreationFailure(error, selected.target, stageDirectory);
  }
  const stageIdentity = stage.windowsIdentity!;
  const stagePath = path.join(stageDirectory, "file");
  const assertStage = () => {
    selected.assertParent();
    assertDirectoryIdentitySync(stageDirectory, stage.stat);
  };
  let file: FileHandle | undefined;
  let identity: BigIntStats | undefined;
  let publication: CreationPublicationStatus = "not-published";
  try {
    if (await inspectCreationDirectory(stageDirectory, true) !== stageIdentity) {
      throw new FsSafeError("path-mismatch", "private staging directory changed before file creation");
    }
    assertSynchronousCallbackResult(assertion?.(), "assertBeforeMutation");
    assertStage();
    file = await fs.open(stagePath, fsSync.constants.O_RDWR | fsSync.constants.O_CREAT |
      fsSync.constants.O_EXCL | resolveReadOpenFlags(), 0o600);
    assertStage();
    identity = assertCreationFile(file.fd, stagePath);
    assertSynchronousCallbackResult(assertion?.(), "assertBeforeMutation");
    assertStage();
    assertCreationFile(file.fd, stagePath, identity);
    const windowsIdentity = await protectCreatedFile(file.fd, stagePath, stageIdentity);
    assertStage();
    assertCreationFile(file.fd, stagePath, identity);
    const source = file;
    file = undefined;
    // The handoff consumes the source pin on both success and failure.
    file = await handoffCreatedFile({
      source, sourcePath: stagePath, targetPath: selected.target, identity,
      assertSourceParent: assertStage, assertTargetParent: selected.assertParent,
      assertBeforeMutation: assertion,
      verifyDescriptor: (fd, pathname, links) => verifyCreatedFile(
        fd, pathname, windowsIdentity, pathname === stagePath ? stageIdentity : parentIdentity, links,
      ),
      onPublished: () => { publication = "published"; },
    });
    assertSynchronousCallbackResult(assertion?.(), "assertBeforeMutation");
    selected.assertParent();
    assertCreationFile(file.fd, selected.target, identity);
    await verifyCreatedFile(file.fd, selected.target, windowsIdentity, parentIdentity);
    selected.assertParent();
    assertCreationFile(file.fd, selected.target, identity);
    await file.chmod(options.mode);
    await verifyCreatedFile(file.fd, selected.target, windowsIdentity, parentIdentity);
    selected.assertParent();
    assertCreationFile(file.fd, selected.target, identity);
    await removeCreationDirectoryAsync(stageDirectory, stage.stat, selected.assertParent);
    selected.assertParent();
    assertCreationFile(file.fd, selected.target, identity);
    return file;
  } catch (primary) {
    publication = creationPublicationAfterFailure(primary, publication);
    const preserved = publication === "indeterminate" || hasUnsettledWindowsSecurityCommand(primary);
    const cleanup: unknown[] = [];
    if (file) {
      const owned = file;
      file = undefined;
      try { await owned.close(); } catch (error) { cleanup.push(error); }
    }
    if (!preserved) {
      if (identity) {
        try { await removeRecordedCreationFile(stagePath, identity, assertStage); }
        catch (error) { cleanup.push(error); }
      }
      try { await removeCreationDirectoryAsync(stageDirectory, stage.stat, selected.assertParent); }
      catch (error) { cleanup.push(error); }
    }
    if (publication === "not-published" && cleanup.length === 0 && !preserved) throw creationCollision(primary);
    throw privateFileSettlementFailure({ primary, cleanup, publication, path: selected.target, stageDirectory, preserved });
  }
}
