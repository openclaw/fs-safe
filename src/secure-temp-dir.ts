import fs from "node:fs";
import { tmpdir as getOsTmpDir } from "node:os";
import path from "node:path";
import { assertSafePathSegment } from "./safe-path-segment.js";

type MaybeNodeError = { code?: string };

type SecureDirStat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  mode?: number;
  uid?: number;
};

export type ResolveSecureTempRootOptions = {
  accessSync?: (path: string, mode?: number) => void;
  chmodSync?: (path: string, mode: number) => void;
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
  const fallbackPrefix = assertSafePathSegment(options.fallbackPrefix, {
    allowDotPrefix: true,
    label: "fallback temp prefix",
  });
  const TMP_DIR_ACCESS_MODE = fs.constants.W_OK | fs.constants.X_OK;
  const accessSync = options.accessSync ?? fs.accessSync;
  const chmodSync = options.chmodSync ?? fs.chmodSync;
  const lstatSync = options.lstatSync ?? fs.lstatSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const warningPrefix = options.warningPrefix ?? "[fs-safe]";
  const unsafeFallbackLabel = options.unsafeFallbackLabel ?? "secure temp dir";
  const getuid =
    options.getuid ??
    (() => {
      try {
        return typeof process.getuid === "function" ? process.getuid() : undefined;
      } catch {
        return undefined;
      }
    });
  const tmpdir = typeof options.tmpdir === "function" ? options.tmpdir : getOsTmpDir;
  const platform = options.platform ?? process.platform;
  const uid = getuid();

  const isSecureDirForUser = (st: { mode?: number; uid?: number }): boolean => {
    if (uid === undefined) {
      return true;
    }
    if (typeof st.uid === "number" && st.uid !== uid) {
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
    try {
      const candidate = lstatSync(candidatePath);
      if (!isTrustedTmpDir(candidate)) {
        return "invalid";
      }
      accessSync(candidatePath, TMP_DIR_ACCESS_MODE);
      return "available";
    } catch (err) {
      if (isNodeErrorWithCode(err, "ENOENT")) {
        return "missing";
      }
      return "invalid";
    }
  };

  const tryRepairWritableBits = (candidatePath: string): boolean => {
    try {
      const st = lstatSync(candidatePath);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        return false;
      }
      if (uid !== undefined && typeof st.uid === "number" && st.uid !== uid) {
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
    accessSync(preferredParentDir, TMP_DIR_ACCESS_MODE);
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
