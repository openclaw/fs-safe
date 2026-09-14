import { randomUUID } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import { tmpdir as getOsTmpDir } from "node:os";
import path from "node:path";
import { resolveEffectiveUid } from "./effective-uid.js";
import { realpathSync } from "./realpath.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { assertSafePathSegment } from "./safe-path-segment.js";

type MaybeNodeError = { code?: string };

type SecureDirStat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode?: number;
  uid?: number;
};

type ExactIdentity = Pick<BigIntStats, "dev" | "ino">;

type OperationProbeDirectoryReceipt = ExactIdentity & {
  realPath: string;
};

export type ResolveSecureTempRootOptions = {
  accessSync?: (path: string, mode?: number) => void;
  chmodSync?: (path: string, mode: number) => void;
  fallbackPrefix: string;
  /** Effective UID adapter; the historical name is retained for compatibility. */
  getuid?: () => number | undefined;
  lstatSync?: (path: string) => SecureDirStat;
  mkdirSync?: (path: string, opts: { recursive: boolean; mode?: number }) => void;
  platform?: NodeJS.Platform;
  preferredDir?: string;
  skipPreferredOnWindows?: boolean;
  tmpdir?: () => string;
  unsafeFallbackLabel?: string;
  warn?: (message: string) => void;
  warningPrefix?: string;
};

function isNodeErrorWithCode(err: unknown, code: string): err is MaybeNodeError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as MaybeNodeError).code === code
  );
}

function isValidCredential(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readProcessCredential(provider: (() => number) | undefined): number | undefined {
  if (typeof provider !== "function") {
    return undefined;
  }
  try {
    const value = provider.call(process);
    return isValidCredential(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function shouldUseOperationProbe(
  platform: NodeJS.Platform,
  hasAccessAdapter: boolean,
): boolean {
  if (hasAccessAdapter || platform === "win32") {
    return false;
  }
  const realUid = readProcessCredential(process.getuid);
  const effectiveUid = readProcessCredential(process.geteuid);
  const realGid = readProcessCredential(process.getgid);
  const effectiveGid = readProcessCredential(process.getegid);
  return !(
    realUid !== undefined &&
    effectiveUid !== undefined &&
    realGid !== undefined &&
    effectiveGid !== undefined &&
    realUid === effectiveUid &&
    effectiveUid !== 0 &&
    realGid === effectiveGid
  );
}

function sameExactIdentity(left: ExactIdentity, right: ExactIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isTrustedOperationProbeDirectory(stat: BigIntStats, uid: number): boolean {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.uid === BigInt(uid) &&
    (stat.mode & 0o022n) === 0n
  );
}

function captureOperationProbeDirectory(
  candidatePath: string,
  uid: number,
): OperationProbeDirectoryReceipt {
  const before = fs.lstatSync(candidatePath, { bigint: true });
  if (!isTrustedOperationProbeDirectory(before, uid)) {
    throw new Error("Operation probe directory is not trusted.");
  }
  const realPath = realpathSync.native(candidatePath);
  const after = fs.lstatSync(candidatePath, { bigint: true });
  const canonical = fs.lstatSync(realPath, { bigint: true });
  if (
    !sameExactIdentity(before, after) ||
    !sameExactIdentity(before, canonical) ||
    !isTrustedOperationProbeDirectory(after, uid) ||
    !isTrustedOperationProbeDirectory(canonical, uid)
  ) {
    throw new Error("Operation probe directory changed during admission.");
  }
  return { dev: before.dev, ino: before.ino, realPath };
}

function isOperationProbeDirectoryCurrent(
  candidatePath: string,
  receipt: OperationProbeDirectoryReceipt,
  uid: number,
): boolean {
  const before = fs.lstatSync(candidatePath, { bigint: true });
  if (
    !sameExactIdentity(before, receipt) ||
    !isTrustedOperationProbeDirectory(before, uid) ||
    realpathSync.native(candidatePath) !== receipt.realPath
  ) {
    return false;
  }
  const after = fs.lstatSync(candidatePath, { bigint: true });
  return sameExactIdentity(after, receipt) && isTrustedOperationProbeDirectory(after, uid);
}

function isPrivateOperationProbeFile(stat: BigIntStats): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1n &&
    (stat.mode & 0o077n) === 0n
  );
}

function hasExactPrivateProbeFile(
  probePath: string,
  receipt: ExactIdentity,
): boolean {
  const current = fs.lstatSync(probePath, { bigint: true });
  return sameExactIdentity(current, receipt) && isPrivateOperationProbeFile(current);
}

function probeDirectoryOperationAccess(candidatePath: string, uid: number): boolean {
  let directoryReceipt: OperationProbeDirectoryReceipt | undefined;
  let probePath: string | undefined;
  let probeReceipt: ExactIdentity | undefined;
  let descriptor: number | undefined;
  let operationVerified = false;
  let closeVerified = true;

  try {
    directoryReceipt = captureOperationProbeDirectory(candidatePath, uid);
    probePath = path.join(directoryReceipt.realPath, `.fs-safe-access-probe-${randomUUID()}`);
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(
      probePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
      0o600,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    probeReceipt = { dev: opened.dev, ino: opened.ino };
    if (
      !isPrivateOperationProbeFile(opened) ||
      !hasExactPrivateProbeFile(probePath, probeReceipt) ||
      !isOperationProbeDirectoryCurrent(candidatePath, directoryReceipt, uid) ||
      !isOperationProbeDirectoryCurrent(directoryReceipt.realPath, directoryReceipt, uid)
    ) {
      throw new Error("Operation probe identity could not be verified.");
    }
    operationVerified = true;
  } catch {
    operationVerified = false;
  }

  if (descriptor !== undefined) {
    const descriptorToClose = descriptor;
    descriptor = undefined;
    try {
      fs.closeSync(descriptorToClose);
    } catch {
      closeVerified = false;
    }
  }

  if (probePath === undefined || probeReceipt === undefined || directoryReceipt === undefined) {
    return false;
  }

  try {
    if (
      !isOperationProbeDirectoryCurrent(candidatePath, directoryReceipt, uid) ||
      !isOperationProbeDirectoryCurrent(directoryReceipt.realPath, directoryReceipt, uid) ||
      !hasExactPrivateProbeFile(probePath, probeReceipt)
    ) {
      return false;
    }
    fs.unlinkSync(probePath);
    if (
      !isOperationProbeDirectoryCurrent(candidatePath, directoryReceipt, uid) ||
      !isOperationProbeDirectoryCurrent(directoryReceipt.realPath, directoryReceipt, uid)
    ) {
      return false;
    }
  } catch {
    return false;
  }

  return operationVerified && closeVerified;
}

export function resolveSecureTempRoot(options: ResolveSecureTempRootOptions): string {
  const fallbackPrefix = assertSafePathSegment(options.fallbackPrefix, {
    allowDotPrefix: true,
    label: "fallback temp prefix",
  });
  const TMP_DIR_ACCESS_MODE = fs.constants.W_OK | fs.constants.X_OK;
  const useOperationProbe = shouldUseOperationProbe(
    options.platform ?? process.platform,
    options.accessSync !== undefined,
  );
  const accessSync = options.accessSync ?? fs.accessSync;
  const chmodSync = options.chmodSync ?? fs.chmodSync;
  const lstatSync = options.lstatSync ?? fs.lstatSync;
  const mkdirSync = options.mkdirSync ?? ((directory: string, mkdirOptions: { recursive: boolean; mode?: number }) =>
    fs.mkdirSync(recursiveMkdirPath(directory), mkdirOptions));
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const warningPrefix = options.warningPrefix ?? "[fs-safe]";
  const unsafeFallbackLabel = options.unsafeFallbackLabel ?? "secure temp dir";
  const tmpdir = typeof options.tmpdir === "function" ? options.tmpdir : getOsTmpDir;
  const platform = options.platform ?? process.platform;
  let uid: number | undefined;
  try {
    uid = resolveEffectiveUid({ getuid: options.getuid, platform });
  } catch (cause) {
    throw new Error(`Unable to determine effective user identity for ${unsafeFallbackLabel}.`, {
      cause,
    });
  }

  const isSecureDirForUser = (st: { mode?: number; uid?: number }): boolean => {
    if (uid === undefined) {
      return platform === "win32";
    }
    if (st.uid !== uid) {
      return false;
    }
    if (typeof st.mode === "number" && (st.mode & 0o022) !== 0) {
      return false;
    }
    return true;
  };

  const fallback = (): string => {
    const base = tmpdir();
    const suffix = uid === undefined ? fallbackPrefix : `${fallbackPrefix}-${uid}`;
    const joiner = platform === "win32" ? path.win32.join : path.join;
    return joiner(base, suffix);
  };

  const isTrustedTmpDir = (st: SecureDirStat): boolean => {
    return st.isDirectory() && !st.isSymbolicLink() && isSecureDirForUser(st);
  };

  const resolveDirState = (candidatePath: string): "available" | "missing" | "invalid" => {
    let candidate: SecureDirStat;
    try {
      candidate = lstatSync(candidatePath);
    } catch (err) {
      if (isNodeErrorWithCode(err, "ENOENT")) {
        return "missing";
      }
      return "invalid";
    }
    if (!isTrustedTmpDir(candidate)) {
      return "invalid";
    }
    try {
      if (useOperationProbe) {
        return uid !== undefined && probeDirectoryOperationAccess(candidatePath, uid)
          ? "available"
          : "invalid";
      }
      accessSync(candidatePath, TMP_DIR_ACCESS_MODE);
      return "available";
    } catch {
      return "invalid";
    }
  };

  const tryRepairWritableBits = (candidatePath: string): boolean => {
    try {
      const st = lstatSync(candidatePath);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        return false;
      }
      if (uid !== undefined && st.uid !== uid) {
        return false;
      }
      if (typeof st.mode !== "number") {
        return false;
      }
      if ((st.mode & 0o022) === 0) {
        return resolveDirState(candidatePath) === "available";
      }
      try {
        chmodSync(candidatePath, 0o700);
      } catch (chmodErr) {
        if (
          isNodeErrorWithCode(chmodErr, "EPERM") ||
          isNodeErrorWithCode(chmodErr, "EACCES") ||
          isNodeErrorWithCode(chmodErr, "ENOENT")
        ) {
          return resolveDirState(candidatePath) === "available";
        }
        throw chmodErr;
      }
      warn(`${warningPrefix} tightened permissions on temp dir: ${candidatePath}`);
      return resolveDirState(candidatePath) === "available";
    } catch {
      return false;
    }
  };

  const ensureTrustedFallbackDir = (): string => {
    const fallbackPath = fallback();
    const state = resolveDirState(fallbackPath);
    if (state === "available") {
      return fallbackPath;
    }
    if (state === "invalid") {
      if (tryRepairWritableBits(fallbackPath)) {
        return fallbackPath;
      }
      throw new Error(`Unsafe fallback ${unsafeFallbackLabel}: ${fallbackPath}`);
    }
    try {
      mkdirSync(fallbackPath, { recursive: true, mode: 0o700 });
      chmodSync(fallbackPath, 0o700);
    } catch {
      throw new Error(`Unable to create fallback ${unsafeFallbackLabel}: ${fallbackPath}`);
    }
    if (resolveDirState(fallbackPath) !== "available" && !tryRepairWritableBits(fallbackPath)) {
      throw new Error(`Unsafe fallback ${unsafeFallbackLabel}: ${fallbackPath}`);
    }
    return fallbackPath;
  };

  if (options.skipPreferredOnWindows === true && platform === "win32") {
    return ensureTrustedFallbackDir();
  }

  if (!options.preferredDir) {
    return ensureTrustedFallbackDir();
  }

  const existingPreferredState = resolveDirState(options.preferredDir);
  if (existingPreferredState === "available") {
    return options.preferredDir;
  }
  if (existingPreferredState === "invalid") {
    if (tryRepairWritableBits(options.preferredDir)) {
      return options.preferredDir;
    }
    return ensureTrustedFallbackDir();
  }

  try {
    const preferredParentDir = path.dirname(options.preferredDir);
    if (!useOperationProbe) {
      accessSync(preferredParentDir, TMP_DIR_ACCESS_MODE);
    }
    mkdirSync(options.preferredDir, { recursive: true, mode: 0o700 });
    chmodSync(options.preferredDir, 0o700);
    if (
      resolveDirState(options.preferredDir) !== "available" &&
      !tryRepairWritableBits(options.preferredDir)
    ) {
      return ensureTrustedFallbackDir();
    }
    return options.preferredDir;
  } catch {
    return ensureTrustedFallbackDir();
  }
}
