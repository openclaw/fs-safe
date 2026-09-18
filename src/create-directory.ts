import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { assertSynchronousCallbackResult } from "./mutation-authority.js";
import {
  assertPrivateDirectory,
  assertPrivateDirectorySync,
  inspectCreationDirectory,
  inspectCreationDirectorySync,
  resolveCreationPermissions,
  type CreationPermissions,
} from "./creation-permissions.js";
import { creationCollision, prepareCreationPath, type CreationParentIdentity } from "./creation-path.js";
import {
  createPrivateWindowsDirectoryCommand,
  createPrivateWindowsDirectoryCommandSync,
} from "./windows-security-command.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";

export type CreateDirectoryOptions = CreationPermissions & { assertBeforeMutation?: () => void };
export type CreationAdmission = { expectedParentIdentity?: CreationParentIdentity };
export type CreationDirectoryReceipt = { stat: BigIntStats; windowsIdentity?: string };

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

export async function createDirectoryWithReceipt(
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
  assertSynchronousCallbackResult(assertion?.(), "assertBeforeMutation");
  selected.assertParent();
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
      await fs.mkdir(selected.target, { mode: permissions.mode });
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

export function createDirectorySyncWithAdmission(
  targetPath: string,
  options: CreateDirectoryOptions = {},
  admission: CreationAdmission = {},
): void {
  createDirectoryWithReceiptSync(targetPath, options, admission);
}

export function createDirectoryWithReceiptSync(
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
  assertSynchronousCallbackResult(assertion?.(), "assertBeforeMutation");
  selected.assertParent();
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
      fsSync.mkdirSync(selected.target, { mode: permissions.mode });
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
