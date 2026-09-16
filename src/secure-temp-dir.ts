import fs from "node:fs";
import { tmpdir as getOsTmpDir } from "node:os";
import path from "node:path";
import { directoryEntryPath } from "./directory-entry-path.js";
import { recursiveMkdirPath } from "./recursive-mkdir-path.js";
import { assertSafePathSegment } from "./safe-path-segment.js";
import {
  captureSecureTempRepairAdapter,
  repairSecureTempDirectory,
  secureTempDirectoryReceipt,
  type SecureTempDirectoryReceipt,
  type SecureTempRootDescriptorAdapter,
} from "./secure-temp-repair.js";
export type { SecureTempRootDescriptorAdapter } from "./secure-temp-repair.js";

type MaybeNodeError = { code?: string };

type SecureDirStat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode?: number | bigint;
  uid?: number | bigint;
};

export type ResolveSecureTempRootOptions = {
  accessSync?: (path: string, mode?: number) => void;
  /** @deprecated Unused. Repairs require descriptor-bound chmod. */
  chmodSync?: (path: string, mode: number) => void;
  descriptor?: SecureTempRootDescriptorAdapter;
  fallbackPrefix: string;
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

export function resolveSecureTempRoot(options: ResolveSecureTempRootOptions): string {
  const {
    fallbackPrefix: prefix, accessSync: suppliedAccess, lstatSync: suppliedLstat,
    mkdirSync: suppliedMkdir, descriptor: suppliedDescriptor, getuid: suppliedGetuid,
    tmpdir: suppliedTmpdir, platform: suppliedPlatform, preferredDir,
    skipPreferredOnWindows, warn: suppliedWarn, warningPrefix: suppliedWarningPrefix,
    unsafeFallbackLabel: suppliedFallbackLabel,
  } = options;
  const platform = suppliedPlatform ?? process.platform;
  const windows = process.platform === "win32" || platform === "win32";
  const capturedDescriptor = captureSecureTempRepairAdapter(
    suppliedDescriptor,
    suppliedAccess !== undefined || suppliedLstat !== undefined || suppliedMkdir !== undefined,
  );
  const descriptor = windows ? undefined : capturedDescriptor;
  const hostLstat = fs.lstatSync;
  const hostMkdir = fs.mkdirSync;
  const hostGetuid = process.getuid;
  const accessSync = suppliedAccess ?? fs.accessSync;
  const lstatSync: (candidate: string) => SecureDirStat = descriptor
    ? (candidate) => descriptor.lstatSync(candidate, { bigint: true })
    : suppliedLstat ?? ((candidate) => windows ? hostLstat(candidate) : hostLstat(candidate, { bigint: true }));
  // Virtual observations cannot authorize host creation. A supplied mkdir hook
  // is explicit authority; chmodSync is deprecated and deliberately not read.
  const mkdirSync = suppliedMkdir ?? (
    suppliedLstat !== undefined || suppliedAccess !== undefined || suppliedDescriptor !== undefined
      ? undefined
      : (directory: string, mkdirOptions: { recursive: boolean; mode?: number }) =>
        hostMkdir(recursiveMkdirPath(directory), mkdirOptions)
  );
  const warn = suppliedWarn ?? console.warn.bind(console);
  const warningPrefix = suppliedWarningPrefix ?? "[fs-safe]";
  const unsafeFallbackLabel = suppliedFallbackLabel ?? "secure temp dir";
  const tmpdir = typeof suppliedTmpdir === "function" ? suppliedTmpdir : getOsTmpDir;
  const getuid = suppliedGetuid ?? (() => {
    try { return typeof hostGetuid === "function" ? hostGetuid.call(process) : undefined; }
    catch { return undefined; }
  });
  const fallbackPrefix = assertSafePathSegment(prefix, {
    allowDotPrefix: true,
    label: "fallback temp prefix",
  });
  const TMP_DIR_ACCESS_MODE = fs.constants.W_OK | fs.constants.X_OK;
  const uid = getuid();
  if (uid !== undefined && (!Number.isSafeInteger(uid) || uid < 0)) {
    throw new Error("Secure temp directory user identity is invalid.");
  }

  const isSecureDirForUser = (st: SecureDirStat): boolean => {
    if (windows || uid === undefined) return true;
    const { uid: owner, mode } = st;
    if (owner !== undefined && owner !== uid && owner !== BigInt(uid)) return false;
    if (typeof mode === "bigint") return mode >= 0n && (mode & 0o022n) === 0n;
    return mode === undefined || (Number.isSafeInteger(mode) && mode >= 0 && (mode & 0o022) === 0);
  };

  const fallback = (): string => {
    const base = tmpdir();
    const suffix = uid === undefined ? fallbackPrefix : `${fallbackPrefix}-${uid}`;
    const joiner = platform === "win32" ? path.win32.join : path.join;
    return joiner(base, suffix);
  };

  type DirState = { kind: "available" | "missing" | "invalid"; receipt?: SecureTempDirectoryReceipt; error?: unknown };
  const resolveDirState = (candidatePath: string): DirState => {
    let candidate: SecureDirStat;
    try {
      candidate = lstatSync(candidatePath);
    } catch (error) {
      return { kind: isNodeErrorWithCode(error, "ENOENT") ? "missing" : "invalid", error };
    }
    let receipt: SecureTempDirectoryReceipt | undefined;
    try {
      if (descriptor && uid !== undefined) {
        receipt = secureTempDirectoryReceipt(candidate as Parameters<typeof secureTempDirectoryReceipt>[0], uid);
      }
      if (receipt ? (receipt.mode & 0o022n) !== 0n :
          candidate.isDirectory() !== true || candidate.isSymbolicLink() !== false || !isSecureDirForUser(candidate)) {
        return { kind: "invalid", receipt };
      }
      accessSync(candidatePath, TMP_DIR_ACCESS_MODE);
      return { kind: "available", receipt };
    } catch (error) {
      return { kind: "invalid", receipt, error };
    }
  };

  const tryRepair = (candidatePath: string, state: DirState, finalize = false): DirState => {
    if (!descriptor || uid === undefined || !state.receipt) {
      return finalize ? { kind: "invalid", error: new Error("Secure temp descriptor finalization is unavailable.") } : state;
    }
    try {
      repairSecureTempDirectory(candidatePath, state.receipt, uid, descriptor,
        () => accessSync(candidatePath, TMP_DIR_ACCESS_MODE),
        () => warn(`${warningPrefix} tightened permissions on temp dir: ${candidatePath}`), finalize);
      return { kind: "available" };
    } catch (error) {
      return { kind: "invalid", error };
    }
  };

  const ensureTrustedFallbackDir = (): string => {
    const fallbackPath = fallback();
    const entryPath = directoryEntryPath(fallbackPath, windows ? "win32" : platform);
    let state = resolveDirState(entryPath);
    let finalize = false;
    if (state.kind === "available") return fallbackPath;
    if (state.kind === "missing") {
      try {
        if (!mkdirSync) throw new Error("Secure temp creation requires an explicit filesystem adapter.");
        const created = mkdirSync(entryPath, { recursive: true, mode: 0o700 });
        finalize = !windows && (suppliedMkdir !== undefined || created !== undefined);
      } catch (cause) {
        throw new Error(`Unable to create fallback ${unsafeFallbackLabel}: ${fallbackPath}`, { cause });
      }
      // A concurrent mkdir winner has no implicit ownership or mode authority.
      state = resolveDirState(entryPath);
      if (state.kind === "available" && !finalize) return fallbackPath;
    }
    state = tryRepair(entryPath, state, finalize);
    if (state.kind !== "available") {
      throw new Error(`Unsafe fallback ${unsafeFallbackLabel}: ${fallbackPath}`, { cause: state.error });
    }
    return fallbackPath;
  };

  if (skipPreferredOnWindows === true && platform === "win32") {
    return ensureTrustedFallbackDir();
  }

  if (!preferredDir) {
    return ensureTrustedFallbackDir();
  }

  const entryPath = directoryEntryPath(preferredDir, windows ? "win32" : platform);
  const existingPreferredState = resolveDirState(entryPath);
  if (existingPreferredState.kind === "available") {
    return preferredDir;
  }
  if (existingPreferredState.kind === "invalid") {
    if (tryRepair(entryPath, existingPreferredState).kind === "available") {
      return preferredDir;
    }
    return ensureTrustedFallbackDir();
  }

  let preferredAvailable = false;
  try {
    const preferredParentDir = (windows ? path.win32 : path).dirname(entryPath);
    accessSync(preferredParentDir, TMP_DIR_ACCESS_MODE);
    if (mkdirSync) {
      const created = mkdirSync(entryPath, { recursive: true, mode: 0o700 });
      const finalize = !windows && (suppliedMkdir !== undefined || created !== undefined);
      const state = resolveDirState(entryPath);
      preferredAvailable = (!finalize && state.kind === "available") || tryRepair(entryPath, state, finalize).kind === "available";
    }
  } catch {
    // A failed preferred path never relaxes fallback admission.
  }
  return preferredAvailable ? preferredDir : ensureTrustedFallbackDir();
}
