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

class StoreDirectoryChain {
  private readonly receipts: ExactDirectoryReceipt[] = [];
  private readonly rootReal: string;

  constructor(rootDir: string, private readonly messagePrefix: StoreMessagePrefix) {
    this.observe(rootDir);
    this.rootReal = storeDirectoryRealPath(rootDir);
  }

  observe(dir: string): void {
    this.receipts.push({
      dir,
      stat: inspectStoreDirectory({
        dir,
        messagePrefix: this.messagePrefix,
        root: this.receipts.length === 0,
      }),
    });
  }

  private inspectReceipt(receipt: ExactDirectoryReceipt, root = false): BigIntStats {
    try {
      const stat = inspectStoreDirectory({
        dir: receipt.dir,
        expected: receipt.stat,
        messagePrefix: this.messagePrefix,
        root,
      });
      if (stat.dev !== receipt.stat.dev || stat.ino !== receipt.stat.ino) {
        throw changedStoreDirectory(this.messagePrefix);
      }
      return stat;
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "outside-workspace") throw error;
      throw changedStoreDirectory(this.messagePrefix, error);
    }
  }

  private assertRoot(): BigIntStats {
    const root = this.receipts[0]!;
    const stat = this.inspectReceipt(root, true);
    try {
      if (storeDirectoryRealPath(root.dir) !== this.rootReal) {
        throw changedStoreDirectory(this.messagePrefix);
      }
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "outside-workspace") throw error;
      throw changedStoreDirectory(this.messagePrefix, error);
    }
    return stat;
  }

  private assertEdge(canonicalRoot = true): BigIntStats {
    const targetIndex = this.receipts.length - 1;
    const rootStat = canonicalRoot
      ? this.assertRoot() : this.inspectReceipt(this.receipts[0]!, true);
    if (targetIndex === 0) return rootStat;
    const parent = this.receipts[targetIndex - 1]!;
    if (targetIndex > 1) this.inspectReceipt(parent);
    const target = this.receipts[targetIndex]!;
    const targetStat = this.inspectReceipt(target);
    if (path.dirname(target.dir) !== parent.dir) {
      throw changedStoreDirectory(this.messagePrefix);
    }
    return targetStat;
  }

  private assertModeTarget(): BigIntStats {
    const root = this.receipts[0]!;
    const target = this.receipts.at(-1)!;
    // The target's canonical observation shares the exact identity fence. Keep
    // the trailing root canonical check: an ancestor relocation can retain IDs.
    this.assertEdge(false);
    let targetReal: string;
    try {
      targetReal = storeDirectoryRealPath(target.dir);
    } catch (error) {
      throw changedStoreDirectory(this.messagePrefix, error);
    }
    if (target === root ? targetReal !== this.rootReal : !isPathInside(this.rootReal, targetReal)) {
      throw changedStoreDirectory(this.messagePrefix);
    }
    return this.assertEdge();
  }

  finish(dir: string): SyncStoreDirectoryReceipt {
    const root = this.receipts[0]!;
    const target = this.receipts.at(-1)!;
    this.assertRoot();
    let finalStat = root.stat;
    for (const [index, receipt] of this.receipts.entries()) {
      if (index === 0) continue;
      finalStat = this.inspectReceipt(receipt);
    }
    let finalReal: string;
    try {
      finalReal = storeDirectoryRealPath(target.dir);
    } catch (error) {
      throw changedStoreDirectory(this.messagePrefix, error);
    }
    if (!isPathInside(this.rootReal, finalReal)) throw changedStoreDirectory(this.messagePrefix);
    this.assertRoot();
    if (target !== root) finalStat = this.inspectReceipt(target);
    return { dir, realPath: finalReal, exactStat: finalStat };
  }

  private openForMode(receipt: ExactDirectoryReceipt): number {
    let openError: unknown;
    try {
      return fs.openSync(pathForWindowsFilesystem(receipt.dir), directoryOpenFlags());
    } catch (error) {
      openError = error;
    }

    const searchFlags = hasErrorCode(openError, "EACCES") ? directorySearchFlags() : undefined;
    if (searchFlags !== undefined) {
      try {
        return fs.openSync(pathForWindowsFilesystem(receipt.dir), searchFlags);
      } catch (searchError) {
        openError = createSuppressedError(
          searchError,
          openError,
          "ordinary and search-only directory opens both failed",
        );
      }
    }

    try {
      this.assertModeTarget();
    } catch (boundaryError) {
      throw changedStoreDirectory(
        this.messagePrefix,
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
        `${this.messagePrefix} directory cannot be safely mode-repaired through a Node descriptor`,
        { cause: openError },
      );
    }
    throw openError;
  }

  private inspectOpened(descriptor: number, receipt: ExactDirectoryReceipt): BigIntStats {
    try {
      const stat = inspectFileIdentitySync(
        () => fs.fstatSync(descriptor, { bigint: true }),
        receipt.stat,
      );
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw changedStoreDirectory(this.messagePrefix);
      }
      return stat;
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "outside-workspace") throw error;
      throw changedStoreDirectory(this.messagePrefix, error);
    }
  }

  finalizeMode(mode: number): void {
    const receipt = this.receipts.at(-1)!;
    const requestedMode = BigInt(mode & 0o7777);
    if ((receipt.stat.mode & 0o7777n) === requestedMode || process.platform === "win32") {
      const current = this.assertEdge();
      // Identity can remain stable while permissions change after the first receipt.
      if (process.platform === "win32" || (current.mode & 0o7777n) === requestedMode) {
        this.receipts[this.receipts.length - 1] = { ...receipt, stat: current };
        return;
      }
    }

    // Repair owns the stronger pre/post mode-target fence below, including an
    // admission check on acquisition failure; no earlier admission is needed.
    const descriptor = this.openForMode(receipt);
    let finalStat: BigIntStats | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      const opened = this.inspectOpened(descriptor, receipt);
      this.assertModeTarget();
      if ((opened.mode & 0o7777n) !== requestedMode) {
        fs.fchmodSync(descriptor, Number(requestedMode));
      }
      const finalized = this.inspectOpened(descriptor, receipt);
      const pathname = this.assertModeTarget();
      if ((finalized.mode & 0o7777n) !== requestedMode ||
        (pathname.mode & 0o7777n) !== requestedMode) {
        throw new FsSafeError(
          "insecure-permissions",
          `${this.messagePrefix} directory mode could not be finalized`,
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
    this.receipts[this.receipts.length - 1] = { ...receipt, stat: finalStat };
  }
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
  const chain = new StoreDirectoryChain(rootDir, params.messagePrefix);
  chain.finalizeMode(params.mode);
  let current = rootDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      chain.observe(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(pathForWindowsFilesystem(current), { mode: params.mode });
      chain.observe(current);
    }
    chain.finalizeMode(params.mode);
  }
  return chain.finish(dir);
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
