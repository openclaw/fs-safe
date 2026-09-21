import { randomUUID } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import fsAsync, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { ownFileDescriptorSync, type OwnedFileDescriptorSync } from "./create-owned-file.js";
import { assertDirectoryIdentitySync, inspectDirectoryIdentitySync } from "./directory-guard.js";
import { FsSafeError } from "./errors.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import {
  assertPrivateFileCreationAvailable,
  inspectCreationDirectorySync,
  protectCreatedFileSync,
  resolveCreationPermissions,
  verifyCreatedFileSync,
  assertPrivateDirectory,
  assertPrivateDirectorySync,
  inspectCreationDirectory,
  type CreationPermissions,
  protectCreatedFile,
  verifyCreatedFile,
} from "./creation-permissions.js";
import {
  assertBeforeCreation,
  creationCollision,
  prepareCreationPath,
  removeCreationDirectory,
  type CreationPath,
  type CreationParentIdentity,
  removeCreationDirectoryAsync,
} from "./creation-path.js";
import { handoffCreatedFileSync } from "./private-producer-handoff-sync.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import {
  assertCreationFile,
  assertPrivateCreationFile,
  creationPublicationAfterFailure,
  privateFileSettlementFailure,
  rethrowPrivateStageCreationFailure,
  removeRecordedCreationFileSync,
  type CreationPublicationStatus,
  removeRecordedCreationFile,
} from "./creation-file-state.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import {
  createPrivateWindowsDirectoryCommand,
  createPrivateWindowsDirectoryCommandSync,
  hasUnsettledWindowsSecurityCommand,
} from "./windows-security-command.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { handoffCreatedFile } from "./private-producer-handoff.js";

export type { OwnedFileDescriptorSync } from "./create-owned-file.js";

export type CreateFileOptions = CreateDirectoryOptions;
function createPrivateWindowsFile(selected: CreationPath, options: CreateFileOptions, mode: number): OwnedFileDescriptorSync {
  const assertion = options.assertBeforeMutation;
  if (fs.lstatSync(selected.target, { throwIfNoEntry: false })) {
    throw new FsSafeError("already-exists", "creation target already exists");
  }
  const parentIdentity = inspectCreationDirectorySync(selected.parent.dir, false);
  selected.assertParent();
  const stageDirectory = path.join(selected.parent.dir, `.fs-safe-create-${randomUUID()}`);
  let stage: ReturnType<typeof createDirectoryWithReceiptSync>;
  try {
    stage = createDirectoryWithReceiptSync(stageDirectory, { private: true, assertBeforeMutation: assertion }, {
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
  let file: OwnedFileDescriptorSync | undefined;
  let identity: BigIntStats | undefined;
  let windowsIdentity: string | undefined;
  let publication: CreationPublicationStatus = "not-published";
  try {
    if (inspectCreationDirectorySync(stageDirectory, true) !== stageIdentity) {
      throw new FsSafeError("path-mismatch", "private staging directory changed before file creation");
    }
    assertSynchronousCallbackResult(assertion?.(), "assertBeforeMutation");
    assertStage();
    file = ownFileDescriptorSync(fs.openSync(stagePath, fs.constants.O_RDWR | fs.constants.O_CREAT |
      fs.constants.O_EXCL | resolveReadOpenFlags(), 0o600));
    identity = assertCreationFile(file.fd, stagePath);
    // The inherited ACL must already be restrictive. This freezes that policy;
    // the bridge refuses to repair broad access on an exposed file.
    assertSynchronousCallbackResult(assertion?.(), "assertBeforeMutation");
    assertStage();
    assertCreationFile(file.fd, stagePath, identity);
    windowsIdentity = protectCreatedFileSync(file.fd, stagePath, stageIdentity);
    assertStage();
    file = handoffCreatedFileSync({
      source: file, sourcePath: stagePath, targetPath: selected.target, identity,
      assertSourceParent: assertStage, assertTargetParent: selected.assertParent,
      assertBeforeMutation: assertion,
      verifyDescriptor: (fd, pathname, links) => verifyCreatedFileSync(
        fd, pathname, windowsIdentity!, pathname === stagePath ? stageIdentity : parentIdentity, links,
      ),
      onPublished: () => { publication = "published"; },
    });
    // Windows may clear the read-only attribute while retiring the stage name.
    // Finalize it only after the published-name descriptor owns the file.
    fs.fchmodSync(file.fd, mode);
    selected.assertParent();
    identity = assertCreationFile(file.fd, selected.target, identity);
    verifyCreatedFileSync(file.fd, selected.target, windowsIdentity, parentIdentity);
    removeCreationDirectory(stageDirectory, stage.stat, selected.assertParent);
    return file;
  } catch (primary) {
    publication = creationPublicationAfterFailure(primary, publication);
    const cleanup: unknown[] = [];
    if (file) {
      try { file.close(); } catch (error) { cleanup.push(error); }
    }
    if (publication !== "indeterminate") {
      if (identity) {
        try { removeRecordedCreationFileSync(stagePath, identity, assertStage); } catch (error) { cleanup.push(error); }
      }
      try { removeCreationDirectory(stageDirectory, stage.stat, selected.assertParent); }
      catch (error) { cleanup.push(error); }
    }
    if (publication === "not-published" && cleanup.length === 0) throw creationCollision(primary);
    throw privateFileSettlementFailure({ primary, cleanup, publication, path: selected.target, stageDirectory });
  }
}

function createFileCore(targetPath: string, options: CreateFileOptions, admission: CreationAdmission): OwnedFileDescriptorSync {
  const permissions = resolveCreationPermissions(options, false);
  const assertion = options.assertBeforeMutation;
  const selected = prepareCreationPath(targetPath, admission.expectedParentIdentity);
  if (permissions.private && process.platform === "win32") {
    assertPrivateFileCreationAvailable();
    return createPrivateWindowsFile(selected, { ...permissions, assertBeforeMutation: assertion }, permissions.mode!);
  }
  assertBeforeCreation(selected, permissions, assertion, "file");
  let file: OwnedFileDescriptorSync;
  try {
    file = ownFileDescriptorSync(fs.openSync(selected.target, fs.constants.O_RDWR | fs.constants.O_CREAT |
      fs.constants.O_EXCL | resolveReadOpenFlags(), permissions.mode ?? 0o666));
  } catch (error) { throw creationCollision(error); }
  try {
    const identity = assertCreationFile(file.fd, selected.target);
    selected.assertParent();
    if (permissions.private) assertPrivateCreationFile(identity, file.fd);
    return file;
  } catch (primary) {
    let failure = primary;
    try { file.close(); }
    catch (closeError) { failure = new AggregateError([primary, closeError], "created file admission and close failed"); }
    throw new FsSafeError("helper-failed", "created file admission failed", {
      cause: failure, details: { publication: { status: "published" }, path: selected.target, cleanup: "preserved" },
    });
  }
}

export function createFileSync(targetPath: string, options: CreateFileOptions = {}): OwnedFileDescriptorSync {
  return createFileCore(targetPath, options, {});
}

/** Internal async writer; Windows preparation uses the nonblocking stage owner. */
export async function createFileHandle(
  targetPath: string,
  options: CreateFileOptions = {},
  admission: CreationAdmission = {},
): Promise<FileHandle> {
  const permissions = resolveCreationPermissions(options, false);
  const assertion = options.assertBeforeMutation;
  if (process.platform !== "win32" || !permissions.private) {
    const selected = prepareCreationPath(targetPath, admission.expectedParentIdentity);
    assertBeforeCreation(selected, permissions, assertion, "file");
    const handle = await fsAsync.open(selected.target, fs.constants.O_RDWR | fs.constants.O_CREAT |
      fs.constants.O_EXCL | resolveReadOpenFlags(), permissions.mode ?? 0o666)
      .catch(error => { throw creationCollision(error); });
    try {
      const identity = assertCreationFile(handle.fd, selected.target);
      selected.assertParent();
      if (permissions.private) assertPrivateCreationFile(identity, handle.fd);
      return handle;
    } catch (primary) {
      let failure = primary;
      try { await handle.close(); }
      catch (closeError) { failure = new AggregateError([primary, closeError], "created file admission and close failed"); }
      throw new FsSafeError("helper-failed", "created file handle admission failed", {
        cause: failure, details: { publication: { status: "published" }, path: selected.target, cleanup: "preserved" },
      });
    }
  }
  assertPrivateFileCreationAvailable();
  return await createPrivateWindowsFileHandle(
    prepareCreationPath(targetPath, admission.expectedParentIdentity),
    { mode: permissions.mode!, assertBeforeMutation: assertion },
  );
}

export type CreateDirectoryOptions = CreationPermissions & { assertBeforeMutation?: () => void };
export type CreationAdmission = { expectedParentIdentity?: CreationParentIdentity };
type CreationDirectoryReceipt = { stat: BigIntStats; windowsIdentity?: string };

function directoryAdoptionFailure(error: unknown, target: string, windowsIdentity?: string): FsSafeError {
  return new FsSafeError("helper-failed", "created directory admission failed", {
    cause: error,
    details: {
      publication: { status: "published" }, path: target, cleanup: "preserved",
      ...(windowsIdentity === undefined ? {} : { windowsIdentity }),
    },
  });
}

function privateDirectoryBackend() {
  const binding = getNativeBinding();
  if (typeof binding?.createPrivateDirectoryWithParentIdentity === "function") {
    return binding.createPrivateDirectoryWithParentIdentity.bind(binding);
  }
  if (getFsSafeNativeConfig().mode === "require") {
    throw new FsSafeError("helper-unavailable", "private directory creation requires an up-to-date native parent identity capability");
  }
  warnNativeFallback("windows-private-directory", "Private Windows directory creation uses a slower built-in system command.");
  return undefined;
}

export async function createDirectory(
  targetPath: string,
  options: CreateDirectoryOptions = {},
): Promise<void> {
  await createDirectoryWithAdmission(targetPath, options, {});
}

export async function createDirectoryWithAdmission(
  targetPath: string,
  options: CreateDirectoryOptions = {},
  admission: CreationAdmission = {},
): Promise<void> {
  await createDirectoryWithReceipt(targetPath, options, admission);
}

async function createDirectoryWithReceipt(
  targetPath: string,
  options: CreateDirectoryOptions = {},
  admission: CreationAdmission = {},
): Promise<CreationDirectoryReceipt> {
  const permissions = resolveCreationPermissions(options, true);
  const assertion = options.assertBeforeMutation;
  const selected = prepareCreationPath(targetPath, admission.expectedParentIdentity);
  const backend = permissions.private && process.platform === "win32" ? privateDirectoryBackend() : undefined;
  const parentIdentity = permissions.private && process.platform === "win32"
    ? await inspectCreationDirectory(selected.parent.dir, false) : undefined;
  assertBeforeCreation(selected, permissions, assertion, "directory");
  let created = false;
  let windowsIdentity: string | undefined;
  try {
    if (parentIdentity !== undefined) {
      const receipt = backend
        ? backend(selected.target, parentIdentity)
        : await createPrivateWindowsDirectoryCommand(selected.target, parentIdentity);
      created = true;
      windowsIdentity = receipt.identity;
      if ((await inspectCreationDirectory(selected.target, true)) !== receipt.identity) {
        throw new FsSafeError("path-mismatch", "created private directory changed before adoption");
      }
    } else {
      await fsAsync.mkdir(selected.target, { mode: permissions.mode });
      created = true;
      if (permissions.private) await assertPrivateDirectory(selected.target);
    }
    selected.assertParent();
    return { stat: inspectDirectoryIdentitySync(selected.target), windowsIdentity };
  } catch (error) {
    if (created) throw directoryAdoptionFailure(error, selected.target, windowsIdentity);
    throw creationCollision(error);
  }
}

export function createDirectorySync(
  targetPath: string,
  options: CreateDirectoryOptions = {},
): void {
  createDirectoryWithReceiptSync(targetPath, options, {});
}

function createDirectoryWithReceiptSync(
  targetPath: string,
  options: CreateDirectoryOptions = {},
  admission: CreationAdmission = {},
): CreationDirectoryReceipt {
  const permissions = resolveCreationPermissions(options, true);
  const assertion = options.assertBeforeMutation;
  const selected = prepareCreationPath(targetPath, admission.expectedParentIdentity);
  const backend = permissions.private && process.platform === "win32" ? privateDirectoryBackend() : undefined;
  const parentIdentity = permissions.private && process.platform === "win32"
    ? inspectCreationDirectorySync(selected.parent.dir, false) : undefined;
  assertBeforeCreation(selected, permissions, assertion, "directory");
  let created = false;
  let windowsIdentity: string | undefined;
  try {
    if (parentIdentity !== undefined) {
      const receipt = backend
        ? backend(selected.target, parentIdentity)
        : createPrivateWindowsDirectoryCommandSync(selected.target, parentIdentity);
      created = true;
      windowsIdentity = receipt.identity;
      if (inspectCreationDirectorySync(selected.target, true) !== receipt.identity) {
        throw new FsSafeError("path-mismatch", "created private directory changed before adoption");
      }
    } else {
      fs.mkdirSync(selected.target, { mode: permissions.mode });
      created = true;
      if (permissions.private) assertPrivateDirectorySync(selected.target);
    }
    selected.assertParent();
    return { stat: inspectDirectoryIdentitySync(selected.target), windowsIdentity };
  } catch (error) {
    if (created) throw directoryAdoptionFailure(error, selected.target, windowsIdentity);
    throw creationCollision(error);
  }
}

async function createPrivateWindowsFileHandle(
  selected: CreationPath,
  options: { mode: number; assertBeforeMutation?: () => void },
): Promise<FileHandle> {
  const assertion = options.assertBeforeMutation;
  const existing = await fsAsync.lstat(selected.target).catch((error: NodeJS.ErrnoException) => {
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
    file = await fsAsync.open(stagePath, fs.constants.O_RDWR | fs.constants.O_CREAT |
      fs.constants.O_EXCL | resolveReadOpenFlags(), 0o600);
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
