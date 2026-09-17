import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { isPathInside, isPathRelativeEscape } from "./path.js";
import { realpathSync } from "./realpath.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { createSuppressedError } from "./suppressed-error.js";
import {
  assertNoWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";

type StoreMessagePrefix = "private store" | "store";

type ExactDirectoryReceipt = Readonly<{
  dir: string;
  stat: BigIntStats;
}>;

export type SyncStoreDirectoryReceipt = Readonly<{
  dir: string;
  realPath: string;
  exactStat: BigIntStats;
}>;

function changedStoreDirectory(
  messagePrefix: StoreMessagePrefix,
  cause?: unknown,
): FsSafeError {
  return new FsSafeError(
    "outside-workspace",
    `${messagePrefix} directory escapes root`,
    { cause },
  );
}

function storeDirectoryRealPath(dir: string): string {
  const operationPath = pathForWindowsFilesystem(dir);
  const realPath = process.platform === "win32"
    ? realpathSync(operationPath) : realpathSync.native(operationPath);
  assertNoWindowsPathAlias(realPath, "filesystem");
  return realPath;
}

function inspectStoreDirectory(params: {
  dir: string;
  expected?: Pick<BigIntStats, "dev" | "ino">;
  messagePrefix: StoreMessagePrefix;
  root: boolean;
}): BigIntStats {
  assertNoWindowsPathAlias(params.dir, "filesystem");
  return inspectFileIdentitySync(() => {
    const stat = fs.lstatSync(pathForWindowsFilesystem(params.dir), { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      const subject = params.root ? "root" : "directory component";
      throw new FsSafeError(
        "not-file",
        `${params.messagePrefix} ${subject} must be a directory: ${params.dir}`,
      );
    }
    return stat;
  }, params.expected);
}

function observeStoreDirectory(params: {
  dir: string;
  messagePrefix: StoreMessagePrefix;
  root: boolean;
}): ExactDirectoryReceipt {
  return {
    dir: params.dir,
    stat: inspectStoreDirectory(params),
  };
}

function inspectReceiptCurrent(
  receipt: ExactDirectoryReceipt,
  messagePrefix: StoreMessagePrefix,
  root: boolean,
): BigIntStats {
  try {
    const stat = inspectStoreDirectory({
      dir: receipt.dir,
      expected: receipt.stat,
      messagePrefix,
      root,
    });
    if (stat.dev !== receipt.stat.dev || stat.ino !== receipt.stat.ino) {
      throw changedStoreDirectory(messagePrefix);
    }
    return stat;
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "outside-workspace") throw error;
    throw changedStoreDirectory(messagePrefix, error);
  }
}

function assertRootCurrent(
  rootReceipt: ExactDirectoryReceipt,
  rootReal: string,
  messagePrefix: StoreMessagePrefix,
): BigIntStats {
  const stat = inspectReceiptCurrent(rootReceipt, messagePrefix, true);
  try {
    if (storeDirectoryRealPath(rootReceipt.dir) !== rootReal) {
      throw changedStoreDirectory(messagePrefix);
    }
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "outside-workspace") throw error;
    throw changedStoreDirectory(messagePrefix, error);
  }
  return stat;
}

function assertAdmittedEdgeCurrent(
  receipts: readonly ExactDirectoryReceipt[],
  rootReal: string | undefined,
  messagePrefix: StoreMessagePrefix,
): BigIntStats {
  const rootReceipt = receipts[0];
  const targetIndex = receipts.length - 1;
  const targetReceipt = receipts[targetIndex];
  if (!rootReceipt || !targetReceipt) {
    throw new FsSafeError("helper-failed", "store directory receipt is missing");
  }
  const rootStat = rootReal === undefined
    ? inspectReceiptCurrent(rootReceipt, messagePrefix, true)
    : assertRootCurrent(rootReceipt, rootReal, messagePrefix);
  if (targetIndex === 0) return rootStat;
  const parent = receipts[targetIndex - 1];
  if (!parent) throw new FsSafeError("helper-failed", "store directory receipt is missing");
  if (targetIndex > 1) inspectReceiptCurrent(parent, messagePrefix, false);
  const targetStat = inspectReceiptCurrent(targetReceipt, messagePrefix, false);
  if (path.dirname(targetReceipt.dir) !== parent.dir) {
    throw changedStoreDirectory(messagePrefix);
  }
  return targetStat;
}

function assertModeTargetCurrent(
  receipts: readonly ExactDirectoryReceipt[],
  rootReal: string,
  messagePrefix: StoreMessagePrefix,
): BigIntStats {
  const root = receipts[0];
  const target = receipts.at(-1);
  if (!root || !target) throw new FsSafeError("helper-failed", "store directory receipt is missing");
  // The target's canonical observation shares the exact identity fence. Keep
  // the trailing root canonical check: an ancestor relocation can retain IDs.
  assertAdmittedEdgeCurrent(receipts, undefined, messagePrefix);
  let targetReal: string;
  try {
    targetReal = storeDirectoryRealPath(target.dir);
  } catch (error) {
    throw changedStoreDirectory(messagePrefix, error);
  }
  if (target === root ? targetReal !== rootReal : !isPathInside(rootReal, targetReal)) {
    throw changedStoreDirectory(messagePrefix);
  }
  return assertAdmittedEdgeCurrent(receipts, rootReal, messagePrefix);
}

function assertReceiptChain(
  receipts: readonly ExactDirectoryReceipt[],
  rootReal: string,
  messagePrefix: StoreMessagePrefix,
): { finalReal: string; finalStat: BigIntStats } {
  const rootReceipt = receipts[0];
  const finalReceipt = receipts.at(-1);
  if (!rootReceipt || !finalReceipt) {
    throw new FsSafeError("helper-failed", "store directory receipt is missing");
  }
  assertRootCurrent(rootReceipt, rootReal, messagePrefix);
  let finalStat = rootReceipt.stat;
  for (const [index, receipt] of receipts.entries()) {
    if (index === 0) continue;
    finalStat = inspectReceiptCurrent(receipt, messagePrefix, false);
  }
  let finalReal: string;
  try {
    finalReal = storeDirectoryRealPath(finalReceipt.dir);
  } catch (error) {
    throw changedStoreDirectory(messagePrefix, error);
  }
  if (!isPathInside(rootReal, finalReal)) throw changedStoreDirectory(messagePrefix);
  assertRootCurrent(rootReceipt, rootReal, messagePrefix);
  if (finalReceipt !== rootReceipt) {
    finalStat = inspectReceiptCurrent(finalReceipt, messagePrefix, false);
  }
  return { finalReal, finalStat };
}

function directoryOpenFlags(): number {
  const { O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = fs.constants;
  if ([O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_RDONLY]
    .some((flag) => typeof flag !== "number")) {
    throw new FsSafeError(
      "helper-unavailable",
      "no-follow directory mode descriptors are unavailable",
    );
  }
  return O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK;
}

function directorySearchFlags(): number | undefined {
  // Linux O_PATH descriptors cannot be fchmoded, and /proc/self/fd would
  // reintroduce a pathname mutation. Darwin O_SEARCH remains descriptor-bound.
  if (process.platform !== "darwin" ||
    (process.arch !== "x64" && process.arch !== "arm64")) return undefined;
  const { O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if ([O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK].some((flag) => typeof flag !== "number")) {
    return undefined;
  }
  // Darwin SDK O_SEARCH = O_EXEC (0x40000000) | O_DIRECTORY on supported Node hosts.
  return 0x40000000 | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK;
}

function hasErrorCode(error: unknown, code: string): boolean {
  if (error && typeof error === "object") {
    if ((error as NodeJS.ErrnoException).code === code) return true;
    const combined = error as { error?: unknown; suppressed?: unknown };
    return (combined.error !== error && hasErrorCode(combined.error, code)) ||
      (combined.suppressed !== error && hasErrorCode(combined.suppressed, code));
  }
  return false;
}

function openStoreDirectoryForMode(params: {
  receipt: ExactDirectoryReceipt;
  receipts: readonly ExactDirectoryReceipt[];
  rootReal: string;
  messagePrefix: StoreMessagePrefix;
}): number {
  let openError: unknown;
  try {
    return fs.openSync(pathForWindowsFilesystem(params.receipt.dir), directoryOpenFlags());
  } catch (error) {
    openError = error;
  }

  const searchFlags = hasErrorCode(openError, "EACCES") ? directorySearchFlags() : undefined;
  if (searchFlags !== undefined) {
    try {
      return fs.openSync(pathForWindowsFilesystem(params.receipt.dir), searchFlags);
    } catch (searchError) {
      openError = createSuppressedError(
        searchError,
        openError,
        "ordinary and search-only directory opens both failed",
      );
    }
  }

  try {
    assertModeTargetCurrent(params.receipts, params.rootReal, params.messagePrefix);
  } catch (boundaryError) {
    throw changedStoreDirectory(
      params.messagePrefix,
      createSuppressedError(
        boundaryError,
        openError,
        "directory acquisition and boundary revalidation both failed",
      ),
    );
  }
  if (hasErrorCode(openError, "EACCES")) {
    throw new FsSafeError(
      "permission-unverified",
      `${params.messagePrefix} directory cannot be safely mode-repaired through a Node descriptor`,
      { cause: openError },
    );
  }
  throw openError;
}

function requestedDirectoryMode(mode: number): bigint {
  return BigInt(mode & 0o7777);
}

function inspectOpenedStoreDirectory(
  descriptor: number,
  receipt: ExactDirectoryReceipt,
  messagePrefix: StoreMessagePrefix,
): BigIntStats {
  try {
    const stat = inspectFileIdentitySync(
      () => fs.fstatSync(descriptor, { bigint: true }),
      receipt.stat,
    );
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw changedStoreDirectory(messagePrefix);
    }
    return stat;
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "outside-workspace") throw error;
    throw changedStoreDirectory(messagePrefix, error);
  }
}

function finalizeDirectoryMode(params: {
  receipts: readonly ExactDirectoryReceipt[];
  rootReal: string;
  mode: number;
  messagePrefix: StoreMessagePrefix;
}): ExactDirectoryReceipt {
  const receipt = params.receipts.at(-1);
  if (!receipt) throw new FsSafeError("helper-failed", "store directory receipt is missing");
  const requestedMode = requestedDirectoryMode(params.mode);
  if ((receipt.stat.mode & 0o7777n) === requestedMode || process.platform === "win32") {
    const current = assertAdmittedEdgeCurrent(params.receipts, params.rootReal, params.messagePrefix);
    // Identity can remain stable while permissions change after the first receipt.
    if (process.platform === "win32" || (current.mode & 0o7777n) === requestedMode) {
      return { ...receipt, stat: current };
    }
  }

  // Repair owns the stronger pre/post mode-target fence below, including an
  // admission check on acquisition failure; no earlier admission is needed.
  const descriptor = openStoreDirectoryForMode({
    receipt,
    receipts: params.receipts,
    rootReal: params.rootReal,
    messagePrefix: params.messagePrefix,
  });
  let finalStat: BigIntStats | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const opened = inspectOpenedStoreDirectory(descriptor, receipt, params.messagePrefix);
    assertModeTargetCurrent(params.receipts, params.rootReal, params.messagePrefix);
    if ((opened.mode & 0o7777n) !== requestedMode) {
      fs.fchmodSync(descriptor, Number(requestedMode));
    }
    const finalized = inspectOpenedStoreDirectory(descriptor, receipt, params.messagePrefix);
    const pathname = assertModeTargetCurrent(
      params.receipts,
      params.rootReal,
      params.messagePrefix,
    );
    if ((finalized.mode & 0o7777n) !== requestedMode ||
      (pathname.mode & 0o7777n) !== requestedMode) {
      throw new FsSafeError(
        "insecure-permissions",
        `${params.messagePrefix} directory mode could not be finalized`,
      );
    }
    finalStat = pathname;
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    fs.closeSync(descriptor);
  } catch (closeError) {
    if (operationFailed) {
      throw createSuppressedError(
        closeError,
        operationError,
        "store directory finalization and close both failed",
      );
    }
    throw closeError;
  }
  if (operationFailed) throw operationError;
  if (!finalStat) throw new FsSafeError("helper-failed", "store directory mode receipt is missing");
  return { ...receipt, stat: finalStat };
}

export function ensureSyncStoreDirectory(params: {
  rootDir: string;
  targetDir: string;
  mode: number;
  messagePrefix: StoreMessagePrefix;
}): SyncStoreDirectoryReceipt {
  assertNoWindowsPathAlias(params.rootDir, "filesystem", "store root uses a Windows filesystem namespace alias");
  assertNoWindowsPathAlias(params.targetDir, "filesystem", "store path uses a Windows filesystem namespace alias");
  const rootDir = resolvePathPreservingWindowsRoot(params.rootDir);
  const dir = resolvePathPreservingWindowsRoot(params.targetDir);
  assertNoWindowsPathAlias(rootDir, "filesystem", "store root uses a Windows filesystem namespace alias");
  assertNoWindowsPathAlias(dir, "filesystem", "store path uses a Windows filesystem namespace alias");
  const relative = path.relative(rootDir, dir);
  if (isPathRelativeEscape(relative)) {
    throw new FsSafeError("outside-workspace", "file path escapes store root");
  }

  fs.mkdirSync(recursiveMkdirPath(pathForWindowsFilesystem(rootDir)), { recursive: true, mode: params.mode });
  const receipts: ExactDirectoryReceipt[] = [observeStoreDirectory({
    dir: rootDir,
    messagePrefix: params.messagePrefix,
    root: true,
  })];
  const rootReal = storeDirectoryRealPath(rootDir);
  receipts[0] = finalizeDirectoryMode({
    receipts,
    rootReal,
    mode: params.mode,
    messagePrefix: params.messagePrefix,
  });

  let current = rootDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let receipt: ExactDirectoryReceipt;
    try {
      receipt = observeStoreDirectory({
        dir: current,
        messagePrefix: params.messagePrefix,
        root: false,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(pathForWindowsFilesystem(current), { mode: params.mode });
      receipt = observeStoreDirectory({
        dir: current,
        messagePrefix: params.messagePrefix,
        root: false,
      });
    }
    receipts.push(receipt);
    receipts[receipts.length - 1] = finalizeDirectoryMode({
      receipts,
      rootReal,
      mode: params.mode,
      messagePrefix: params.messagePrefix,
    });
  }

  const finalChain = assertReceiptChain(receipts, rootReal, params.messagePrefix);
  return {
    dir,
    realPath: finalChain.finalReal,
    exactStat: finalChain.finalStat,
  };
}

export function assertSyncStoreDirectoryReceipt(
  receipt: SyncStoreDirectoryReceipt,
): void {
  try {
    assertNoWindowsPathAlias(receipt.realPath, "filesystem");
    const stat = inspectStoreDirectory({
      dir: receipt.dir,
      expected: receipt.exactStat,
      messagePrefix: "store",
      root: false,
    });
    if (stat.dev !== receipt.exactStat.dev || stat.ino !== receipt.exactStat.ino ||
      storeDirectoryRealPath(receipt.dir) !== receipt.realPath) {
      throw new FsSafeError("path-mismatch", "store directory changed during write");
    }
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "path-mismatch" &&
      error.message !== "store directory changed during write") {
      throw new FsSafeError("path-mismatch", "store directory changed during write", {
        cause: error,
      });
    }
    throw error;
  }
}
