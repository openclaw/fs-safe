import fsSync, { type BigIntStats, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureAbsoluteDirectory } from "./absolute-path.js";
import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
import {
  assertDirectoryReceiptCurrentSync,
  copyRetainedDirectoryReceipt,
  createDirectoryReceiptSync,
  directoryReceiptAuthority,
  directoryReceiptIdentity,
  ownDirectoryReceipt,
} from "./directory-receipt.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { assertNoWindowsPathAlias, pathForWindowsFilesystem, resolvePathPreservingWindowsRoot } from "./windows-path-alias.js";
import { realpathSync } from "./realpath.js";

export type DirectorySyncOutcome =
  | { status: "synced" }
  | { status: "unsupported"; code?: string };

export type DirectoryReceipt<T extends Stats | BigIntStats = Stats> = {
  path: string;
  realPath: string;
  identity: T;
};

export type DurableDirectoryReceipt = DirectoryReceipt & {
  parentSync: DirectorySyncOutcome | { status: "not-needed" };
};

export type PinnedDirectory = {
  readonly receipt: DirectoryReceipt;
  assertCurrent(): Promise<void>;
  sync(): Promise<DirectorySyncOutcome>;
  close(): Promise<void>;
};

export type EnsureDurableDirectoryOptions = {
  directoryPath: string;
  label?: string;
  mode?: number;
  expectedExistingIdentity?: FileIdentityStat;
  create?: (directoryPath: string) => Promise<void>;
};

function directoryOpenFlags(): string | number {
  if (process.platform === "win32") {
    return "r";
  }
  return (
    fsSync.constants.O_RDONLY |
    fsSync.constants.O_DIRECTORY |
    fsSync.constants.O_NOFOLLOW |
    fsSync.constants.O_NONBLOCK
  );
}

function isWindowsDirectorySyncUnsupported(error: unknown): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EACCES" ||
    code === "EINVAL" ||
    code === "EISDIR" ||
    code === "ENOSYS" ||
    code === "ENOTSUP" ||
    code === "EPERM"
  );
}

function isWindowsDirectoryOpenUnsupported(error: unknown): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "EISDIR" || code === "ENOSYS" || code === "ENOTSUP";
}

function unsupportedOutcome(error: unknown): DirectorySyncOutcome {
  const code = (error as NodeJS.ErrnoException).code;
  return code ? { status: "unsupported", code } : { status: "unsupported" };
}

async function createDirectoryReceipt(directoryPath: string, label: string): Promise<DirectoryReceipt> {
  return createDirectoryReceiptSync(directoryPath, label, realpathSync.native);
}

async function assertDirectoryReceiptCurrent(receipt: DirectoryReceipt, label: string): Promise<void> {
  assertDirectoryReceiptCurrentSync(receipt, label, realpathSync.native);
}

function assertOpenDirectoryIdentity(descriptor: number, receipt: DirectoryReceipt, label: string): void {
  inspectFileIdentitySync(() => {
    const opened = fsSync.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory()) {
      throw new FsSafeError("not-file", `${label} must be a real directory: ${receipt.path}`);
    }
    return opened;
  }, directoryReceiptAuthority(receipt).identity);
}

async function assertOpenDirectoryCurrent(
  handle: FileHandle,
  receipt: DirectoryReceipt,
  label: string,
): Promise<void> {
  assertOpenDirectoryIdentity(handle.fd, receipt, label);
  await assertDirectoryReceiptCurrent(receipt, label);
}

class PinnedDirectoryImpl implements PinnedDirectory {
  readonly receipt: DirectoryReceipt;
  readonly #authority: DirectoryReceipt;
  readonly #handle: FileHandle;
  readonly #label: string;
  #closed = false;

  constructor(handle: FileHandle, receipt: DirectoryReceipt, label: string) {
    this.#handle = handle;
    this.#authority = receipt;
    this.receipt = copyRetainedDirectoryReceipt(receipt);
    this.#label = label;
  }

  async assertCurrent(): Promise<void> {
    if (this.#closed) {
      throw new FsSafeError("helper-failed", `${this.#label} pin is already closed`);
    }
    await assertOpenDirectoryCurrent(this.#handle, this.#authority, this.#label);
  }

  async sync(): Promise<DirectorySyncOutcome> {
    await this.assertCurrent();
    try {
      await this.#handle.sync();
    } catch (error) {
      if (!isWindowsDirectorySyncUnsupported(error)) {
        throw error;
      }
      await this.assertCurrent();
      return unsupportedOutcome(error);
    }
    await this.assertCurrent();
    return { status: "synced" };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#handle.close();
  }
}

export async function pinDirectory(
  directory: string | DirectoryReceipt<Stats | BigIntStats>,
  options: { label?: string } = {},
): Promise<PinnedDirectory> {
  const label = options.label ?? "directory";
  const receipt =
    typeof directory === "string"
      ? await createDirectoryReceipt(directory, label)
      : ownDirectoryReceipt(directory);
  await assertDirectoryReceiptCurrent(receipt, label);
  const handle = await fs.open(pathForWindowsFilesystem(receipt.path), directoryOpenFlags());
  try {
    await assertOpenDirectoryCurrent(handle, receipt, label);
    return new PinnedDirectoryImpl(handle, receipt, label);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function syncDirectory(
  directory: string | DirectoryReceipt<Stats | BigIntStats>,
  options: { label?: string } = {},
): Promise<DirectorySyncOutcome> {
  const label = options.label ?? "directory";
  const receipt =
    typeof directory === "string"
      ? await createDirectoryReceipt(directory, label)
      : ownDirectoryReceipt(directory);
  let pinned: PinnedDirectory;
  try {
    pinned = await pinDirectory(receipt, { label });
  } catch (error) {
    if (!isWindowsDirectoryOpenUnsupported(error)) {
      throw error;
    }
    await assertDirectoryReceiptCurrent(receipt, label);
    return unsupportedOutcome(error);
  }
  try {
    return await pinned.sync();
  } finally {
    await pinned.close();
  }
}

export function syncDirectorySync(
  directory: string | DirectoryReceipt<Stats | BigIntStats>,
  options: { label?: string } = {},
): DirectorySyncOutcome {
  const label = options.label ?? "directory";
  const receipt =
    typeof directory === "string"
      ? createDirectoryReceiptSync(directory, label)
      : ownDirectoryReceipt(directory);
  assertDirectoryReceiptCurrentSync(receipt, label);
  let descriptor: number;
  try {
    descriptor = fsSync.openSync(pathForWindowsFilesystem(receipt.path), directoryOpenFlags());
  } catch (error) {
    if (!isWindowsDirectoryOpenUnsupported(error)) {
      throw error;
    }
    assertDirectoryReceiptCurrentSync(receipt, label);
    return unsupportedOutcome(error);
  }
  try {
    assertOpenDirectoryIdentity(descriptor, receipt, label);
    assertDirectoryReceiptCurrentSync(receipt, label);
    try {
      fsSync.fsyncSync(descriptor);
    } catch (error) {
      if (!isWindowsDirectorySyncUnsupported(error)) {
        throw error;
      }
      assertDirectoryReceiptCurrentSync(receipt, label);
      return unsupportedOutcome(error);
    }
    assertDirectoryReceiptCurrentSync(receipt, label);
    return { status: "synced" };
  } finally {
    fsSync.closeSync(descriptor);
  }
}

export async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  await syncDirectory(directoryPath).catch(() => undefined);
}

export function syncDirectoryBestEffortSync(directoryPath: string): void {
  try {
    syncDirectorySync(directoryPath);
  } catch {
    // Compatibility helper for operations whose primary write may remain usable.
  }
}

async function findExistingAncestorReceipt(
  targetPath: string,
  label: string,
): Promise<DirectoryReceipt> {
  assertNoWindowsPathAlias(
    targetPath,
    "filesystem",
    `${label} path uses a Windows filesystem namespace alias`,
  );
  let currentPath = resolvePathPreservingWindowsRoot(targetPath);
  assertNoWindowsPathAlias(
    currentPath,
    "filesystem",
    `${label} path uses a Windows filesystem namespace alias`,
  );
  while (true) {
    try {
      return await createDirectoryReceipt(currentPath, label);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new FsSafeError("not-found", `${label} has no existing directory ancestor`);
    }
    currentPath = parentPath;
  }
}

export async function ensureDurableDirectory(
  options: EnsureDurableDirectoryOptions,
): Promise<DurableDirectoryReceipt> {
  const label = options.label ?? "directory";
  const requestedDirectoryPath = options.directoryPath;
  assertNoWindowsPathAlias(
    requestedDirectoryPath,
    "filesystem",
    `${label} path uses a Windows filesystem namespace alias`,
  );
  const directoryPath = resolvePathPreservingWindowsRoot(requestedDirectoryPath);
  assertNoWindowsPathAlias(
    directoryPath,
    "filesystem",
    `${label} path uses a Windows filesystem namespace alias`,
  );
  const expectedInput = options.expectedExistingIdentity;
  const expectedIdentity = expectedInput && directoryReceiptIdentity(expectedInput);
  const ancestorReceipt = await findExistingAncestorReceipt(directoryPath, label);
  const targetExists = ancestorReceipt.path === directoryPath;
  if (expectedIdentity && !targetExists) {
    throw new FsSafeError(
      "path-mismatch",
      `${label} changed before durable directory pinning: ${directoryPath}`,
    );
  }

  if (expectedIdentity) {
    inspectFileIdentitySync(() => directoryReceiptAuthority(ancestorReceipt).identity, expectedIdentity);
  }

  const ancestor = await pinDirectory(ancestorReceipt, { label });
  const pinnedDirectories: PinnedDirectory[] = [ancestor];
  try {
    await ancestor.assertCurrent();
    if (!targetExists) {
      const create = options.create;
      if (create) {
        await Reflect.apply(create, options, [directoryPath]);
      } else {
        const created = await ensureAbsoluteDirectory(directoryPath, {
          mode: options.mode,
          scopeLabel: label,
        });
        if (!created.ok) {
          throw created.error;
        }
      }
    }
    await ancestor.assertCurrent();

    let currentPath = ancestor.receipt.path;
    for (const segment of path
      .relative(ancestor.receipt.path, directoryPath)
      .split(path.sep)
      .filter(Boolean)) {
      currentPath = path.join(currentPath, segment);
      pinnedDirectories.push(await pinDirectory(currentPath, { label }));
    }

    let parentSync: DurableDirectoryReceipt["parentSync"] = { status: "not-needed" };
    for (let index = pinnedDirectories.length - 1; index > 0; index -= 1) {
      const parent = pinnedDirectories[index - 1];
      const child = pinnedDirectories[index];
      if (!parent || !child) {
        throw new FsSafeError("helper-failed", `${label} directory pin chain is incomplete`);
      }
      await child.assertCurrent();
      try {
        const outcome = await parent.sync();
        if (outcome.status === "unsupported") {
          parentSync = outcome;
        } else if (parentSync.status === "not-needed") {
          parentSync = outcome;
        }
      } catch (error) {
        throw new FsSafeError(
          "helper-failed",
          `${label} could not sync created directory edge ${child.receipt.path} through ${parent.receipt.path}`,
          { cause: error },
        );
      }
      await child.assertCurrent();
    }

    const finalReceipt = pinnedDirectories.at(-1)?.receipt;
    if (!finalReceipt) {
      throw new FsSafeError("helper-failed", `${label} directory receipt is missing`);
    }
    await ancestor.assertCurrent();
    await assertDirectoryReceiptCurrent(finalReceipt, label);
    return Object.assign(copyRetainedDirectoryReceipt(finalReceipt), { parentSync });
  } finally {
    await Promise.all(pinnedDirectories.toReversed().map(async (directory) => directory.close()));
  }
}
