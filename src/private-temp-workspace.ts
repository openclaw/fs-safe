import { randomInt, randomUUID } from "node:crypto";
import fsSync, { type BigIntStats, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  fileStore,
  fileStoreSync,
} from "./file-store.js";
import { FsSafeError } from "./errors.js";
import { isNotFoundPathError } from "./path.js";
import { inspectDirectoryIdentitySync } from "./directory-guard.js";
import { throwFsSafeReadError } from "./root-errors.js";
import {
  matchRootFileOpenFailure,
  openRootFileSync,
  type RootFileOpenFailure,
} from "./root-file.js";
import {
  registerTempPathForExit,
} from "./temp-cleanup.js";
import {
  TempWorkspaceCleanupCapability,
  TempWorkspaceCleanupOwner,
  type TempWorkspaceCleanupSafety,
} from "./temp-workspace-owner.js";
import {
  assertNoWindowsPathAlias,
  hasWindowsPathAlias,
} from "./windows-path-alias.js";
import { TempWorkspaceRetainedChild } from "./temp-workspace-descriptor.js";
import {
  admitRetainedTempWorkspaceChild,
  admitRetainedTempWorkspaceChildSync,
  validateInitialTempWorkspaceChild,
} from "./temp-workspace-child-admission.js";
import {
  admitTempWorkspaceRoot,
  admitTempWorkspaceRootSync,
} from "./temp-workspace-admission.js";
import { validateTempWorkspaceDirMode } from "./temp-workspace-permissions.js";
import type { TempWorkspaceOptions, TempWorkspace, TempWorkspaceSync } from "./temp-workspace-types.js";

export type {
  TempWorkspaceCleanupMechanism,
  TempWorkspaceCleanupResult,
  TempWorkspaceCleanupSafety,
} from "./temp-workspace-owner.js";

export type { TempWorkspaceOptions, TempWorkspace, TempWorkspaceSync } from "./temp-workspace-types.js";

function resolveTempWorkspaceCleanupSafety(
  value: TempWorkspaceCleanupSafety | undefined,
): TempWorkspaceCleanupSafety {
  if (value === undefined || value === "compatible") return "compatible";
  if (value === "require-bounded") return value;
  throw new TypeError("cleanupSafety must be compatible or require-bounded");
}

function sanitizeTempPrefix(prefix: string): string {
  const sanitized = prefix.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "fs-safe-";
  }
  return sanitized.endsWith("-") ? sanitized : `${sanitized}-`;
}

const TEMP_WORKSPACE_SUFFIX_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const TEMP_WORKSPACE_SUFFIX_SPACE = TEMP_WORKSPACE_SUFFIX_ALPHABET.length ** 6;
const TEMP_WORKSPACE_DIRECT_CREATE_ATTEMPTS = 64;

function randomTempWorkspaceChildPath(childPrefix: string): string {
  let encoded = randomInt(TEMP_WORKSPACE_SUFFIX_SPACE);
  let suffix = "";
  for (let index = 0; index < 6; index += 1) {
    suffix = TEMP_WORKSPACE_SUFFIX_ALPHABET[encoded % TEMP_WORKSPACE_SUFFIX_ALPHABET.length]! + suffix;
    encoded = Math.floor(encoded / TEMP_WORKSPACE_SUFFIX_ALPHABET.length);
  }
  return `${childPrefix}${suffix}`;
}

function canCreateTempWorkspaceWithRequestedMode(dirMode: number): boolean {
  return (process.platform === "linux" || process.platform === "darwin") && dirMode !== 0o700 &&
    (dirMode & 0o700) === 0o700 && (dirMode & 0o7000) === 0 && (dirMode & 0o022) === 0;
}

function createTempWorkspaceWithRequestedModeSync(
  childPrefix: string,
  dirMode: number,
  prepareChildCreation: () => void,
): string {
  let collision: unknown;
  for (let attempt = 0; attempt < TEMP_WORKSPACE_DIRECT_CREATE_ATTEMPTS; attempt += 1) {
    const candidate = randomTempWorkspaceChildPath(childPrefix);
    prepareChildCreation();
    try {
      fsSync.mkdirSync(candidate, { mode: dirMode, recursive: false });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      collision = error;
    }
  }
  throw collision;
}

function resolveWorkspaceLeaf(dir: string, fileName: string): string {
  const resolved = path.join(dir, assertWorkspaceFileName(fileName));
  assertNoWindowsPathAlias(resolved, "filesystem", "temp workspace path uses a Windows filesystem namespace alias");
  return resolved;
}

function assertWorkspaceFileName(fileName: string): string {
  const value = fileName.trim();
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\") ||
    hasWindowsPathAlias(value, "relative") ||
    path.basename(value) !== value
  ) {
    throw new Error(`Invalid temp workspace file name: ${JSON.stringify(fileName)}`);
  }
  return value;
}

function throwTempWorkspaceOpenFailure(failure: RootFileOpenFailure): never {
  return matchRootFileOpenFailure<never>(failure, {
    path: ({ error }) => {
      if (isNotFoundPathError(error)) {
        throw new FsSafeError("not-found", "temp workspace file not found", { cause: error });
      }
      throw new FsSafeError("path-mismatch", "temp workspace target changed during read", {
        cause: error,
      });
    },
    validation: ({ error }) => {
      if (error instanceof FsSafeError) {
        throw error;
      }
      throw new FsSafeError("path-mismatch", "temp workspace target failed read validation", {
        cause: error,
      });
    },
    io: ({ error }) => throwFsSafeReadError(error, "temp workspace"),
    fallback: ({ error }) => {
      throw new FsSafeError("path-mismatch", "temp workspace target changed during read", {
        cause: error,
      });
    },
  });
}

async function createTempWorkspace(
  options: TempWorkspaceOptions,
  scopedPrefix = false,
): Promise<TempWorkspace> {
  const rootDir = options.rootDir;
  assertNoWindowsPathAlias(rootDir, "filesystem", "temp workspace root uses a Windows filesystem namespace alias");
  const dirMode = options.dirMode ?? 0o700;
  validateTempWorkspaceDirMode(dirMode);
  const mode = options.mode ?? 0o600;
  const cleanupSafety = resolveTempWorkspaceCleanupSafety(options.cleanupSafety);
  const admission = await admitTempWorkspaceRoot(rootDir);
  const root = admission.dir;
  assertNoWindowsPathAlias(root, "filesystem", "temp workspace root uses a Windows filesystem namespace alias");
  // Capture and sanitize caller-controlled prefix data before retaining descriptors.
  const rawPrefix = options.prefix;
  const workspacePrefix = scopedPrefix
    ? `${sanitizeTempPrefix(rawPrefix)}${randomUUID()}-`
    : rawPrefix;
  const childPrefix = path.join(root, sanitizeTempPrefix(workspacePrefix));
  assertNoWindowsPathAlias(childPrefix, "filesystem", "temp workspace path uses a Windows filesystem namespace alias");
  const capability = new TempWorkspaceCleanupCapability(root, cleanupSafety, admission, dirMode);
  let dir: string;
  let stat: BigIntStats | Stats;
  let retainedChild: TempWorkspaceRetainedChild | undefined;
  let retainChildDescriptor = false;
  let cleanupOwner: TempWorkspaceCleanupOwner | undefined;
  let unregisterTempDir: () => void;
  try {
    // Native capability discovery is complete before this synchronous
    // boundary. The existing canonical-root route now captures the complete
    // ancestry and associates its provisional parent descriptor here, then
    // dispatches mkdtemp without yielding or invoking another probe.
    capability.prepareChildCreation();
    dir = await fs.mkdtemp(childPrefix);
    assertNoWindowsPathAlias(dir, "filesystem", "temp workspace path uses a Windows filesystem namespace alias");
    if (capability.parent) capability.assertCurrent();
    else admission.assertCurrent();
    stat = inspectDirectoryIdentitySync(dir);
    const needsModeInitialization = validateInitialTempWorkspaceChild(
      stat,
      admission.ownerUid,
      dirMode,
    );
    // Retain while the child still has its private creation mode so an
    // explicit dirMode such as 0 cannot make identity descriptor acquisition fail.
    retainedChild = TempWorkspaceRetainedChild.retain(dir, stat);
    const modeInitialization = admitRetainedTempWorkspaceChild(
      retainedChild,
      needsModeInitialization,
      admission,
      dirMode,
    );
    if (modeInitialization) await modeInitialization;
    retainChildDescriptor = capability.admitChildDescriptor(retainedChild.ensureReadable());
    // Final adoption order is deliberate: complete ancestry, retained cleanup
    // parent, then descriptor and named checks of the original child identity.
    if (capability.parent) capability.assertAncestryCurrent();
    else admission.assertAncestry();
    stat = retainedChild.finalizeAdmission(admission.ownerUid, dirMode);
    cleanupOwner = new TempWorkspaceCleanupOwner(
      retainedChild,
      capability,
      retainChildDescriptor,
    );
    retainedChild = undefined;
    unregisterTempDir = registerTempPathForExit(dir, {
      cleanupSync: () => cleanupOwner!.cleanupSync(),
    });
  } catch (error) {
    try {
      if (cleanupOwner) cleanupOwner.cleanupSync();
      else {
        const closeErrors: unknown[] = [];
        try { retainedChild?.close(); } catch (closeError) { closeErrors.push(closeError); }
        try { capability.close(); } catch (closeError) { closeErrors.push(closeError); }
        if (closeErrors.length === 1) throw closeErrors[0];
        if (closeErrors.length > 1) {
          throw new AggregateError(closeErrors, "temp workspace admission descriptor close failed");
        }
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "temp workspace creation and cleanup both failed");
    }
    throw error;
  }
  const owner = cleanupOwner!;
  const identity = { dev: Number(stat.dev), ino: Number(stat.ino) };
  // Once registered, even a store-construction failure remains exit-cleanable.
  const store = fileStore({ rootDir: dir, private: true, dirMode, mode });

  return {
    dir,
    identity,
    store,
    cleanupMechanism: owner.cleanupMechanism,
    path: (fileName) => resolveWorkspaceLeaf(dir, fileName),
    write: async (fileName, data) =>
      await store.write(assertWorkspaceFileName(fileName), data, { mode }),
    writeText: async (fileName, data) =>
      await store.writeText(assertWorkspaceFileName(fileName), data, { mode }),
    writeJson: async (fileName, data, writeOptions) =>
      await store.writeJson(assertWorkspaceFileName(fileName), data, {
        mode,
        trailingNewline: writeOptions?.trailingNewline,
      }),
    copyIn: async (fileName, sourcePath) =>
      await store.copyIn(assertWorkspaceFileName(fileName), sourcePath, { mode }),
    read: async (fileName) => {
      try {
        return await store.readBytes(assertWorkspaceFileName(fileName));
      } catch (error) {
        throwFsSafeReadError(error, "temp workspace");
      }
    },
    cleanup: async () => {
      try {
        return await owner.cleanup();
      } finally {
        unregisterTempDir();
      }
    },
    [Symbol.asyncDispose]: async () => {
      try {
        await owner.cleanup();
      } finally {
        unregisterTempDir();
      }
    },
  };
}

export async function tempWorkspace(
  options: TempWorkspaceOptions,
): Promise<TempWorkspace> {
  return await createTempWorkspace(options);
}

export async function withTempWorkspace<T>(
  options: TempWorkspaceOptions,
  run: (workspace: TempWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await createTempWorkspace(options, true);
  try {
    return await run(workspace);
  } finally {
    await workspace.cleanup();
  }
}

function createTempWorkspaceSync(
  options: TempWorkspaceOptions,
  scopedPrefix = false,
): TempWorkspaceSync {
  const rootDir = options.rootDir;
  assertNoWindowsPathAlias(rootDir, "filesystem", "temp workspace root uses a Windows filesystem namespace alias");
  const dirMode = options.dirMode ?? 0o700;
  validateTempWorkspaceDirMode(dirMode);
  const mode = options.mode ?? 0o600;
  const cleanupSafety = resolveTempWorkspaceCleanupSafety(options.cleanupSafety);
  const admission = admitTempWorkspaceRootSync(rootDir);
  const root = admission.dir;
  assertNoWindowsPathAlias(root, "filesystem", "temp workspace root uses a Windows filesystem namespace alias");
  // Capture and sanitize caller-controlled prefix data before retaining descriptors.
  const rawPrefix = options.prefix;
  const workspacePrefix = scopedPrefix
    ? `${sanitizeTempPrefix(rawPrefix)}${randomUUID()}-`
    : rawPrefix;
  const childPrefix = path.join(root, sanitizeTempPrefix(workspacePrefix));
  assertNoWindowsPathAlias(childPrefix, "filesystem", "temp workspace path uses a Windows filesystem namespace alias");
  const capability = new TempWorkspaceCleanupCapability(root, cleanupSafety, admission, dirMode);
  let dir: string;
  let stat: BigIntStats | Stats;
  let retainedChild: TempWorkspaceRetainedChild | undefined;
  let retainChildDescriptor = false;
  let needsModeInitialization: boolean;
  let cleanupOwner: TempWorkspaceCleanupOwner | undefined;
  let unregisterTempDir: () => void;
  try {
    const directRequestedMode = canCreateTempWorkspaceWithRequestedMode(dirMode);
    if (directRequestedMode) {
      dir = createTempWorkspaceWithRequestedModeSync(
        childPrefix,
        dirMode,
        () => capability.prepareChildCreation(),
      );
    } else {
      capability.prepareChildCreation();
      dir = fsSync.mkdtempSync(childPrefix);
    }
    assertNoWindowsPathAlias(dir, "filesystem", "temp workspace path uses a Windows filesystem namespace alias");
    if (capability.parent) capability.assertCurrent();
    else admission.assertCurrent();
    if (directRequestedMode) {
      const created = TempWorkspaceRetainedChild.retainCreated(dir);
      retainedChild = created.retained;
      stat = created.stat;
      needsModeInitialization = validateInitialTempWorkspaceChild(
        stat,
        admission.ownerUid,
        dirMode,
      );
    } else {
      stat = inspectDirectoryIdentitySync(dir);
      needsModeInitialization = validateInitialTempWorkspaceChild(
        stat,
        admission.ownerUid,
        dirMode,
      );
      retainedChild = TempWorkspaceRetainedChild.retain(dir, stat);
    }
    admitRetainedTempWorkspaceChildSync(
      retainedChild,
      needsModeInitialization,
      admission,
      dirMode,
    );
    retainChildDescriptor = capability.admitChildDescriptor(retainedChild.ensureReadable());
    // Match async adoption: complete ancestry and retained cleanup authority
    // precede descriptor and named child security-state checks.
    if (capability.parent) capability.assertAncestryCurrent();
    else admission.assertAncestry();
    stat = retainedChild.finalizeAdmission(admission.ownerUid, dirMode);
    cleanupOwner = new TempWorkspaceCleanupOwner(
      retainedChild,
      capability,
      retainChildDescriptor,
    );
    retainedChild = undefined;
    unregisterTempDir = registerTempPathForExit(dir, {
      cleanupSync: () => cleanupOwner!.cleanupSync(),
    });
  } catch (error) {
    try {
      if (cleanupOwner) cleanupOwner.cleanupSync();
      else {
        const closeErrors: unknown[] = [];
        try { retainedChild?.close(); } catch (closeError) { closeErrors.push(closeError); }
        try { capability.close(); } catch (closeError) { closeErrors.push(closeError); }
        if (closeErrors.length === 1) throw closeErrors[0];
        if (closeErrors.length > 1) {
          throw new AggregateError(closeErrors, "temp workspace admission descriptor close failed");
        }
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "temp workspace creation and cleanup both failed");
    }
    throw error;
  }
  const owner = cleanupOwner!;
  const identity = { dev: Number(stat.dev), ino: Number(stat.ino) };
  // Once registered, even a store-construction failure remains exit-cleanable.
  const store = fileStoreSync({ rootDir: dir, private: true, dirMode, mode });

  return {
    dir,
    identity,
    store,
    cleanupMechanism: owner.cleanupMechanism,
    path: (fileName) => resolveWorkspaceLeaf(dir, fileName),
    write: (fileName, data) =>
      store.write(assertWorkspaceFileName(fileName), data, { mode }),
    writeText: (fileName, data) =>
      store.writeText(assertWorkspaceFileName(fileName), data, { mode }),
    writeJson: (fileName, data, writeOptions) =>
      store.writeJson(assertWorkspaceFileName(fileName), data, {
        mode,
        trailingNewline: writeOptions?.trailingNewline,
      }),
    read: (fileName) => {
      const opened = openRootFileSync({
        absolutePath: store.path(assertWorkspaceFileName(fileName)),
        rootPath: dir,
        boundaryLabel: "temp workspace",
        rejectHardlinks: true,
      });
      if (!opened.ok) {
        throwTempWorkspaceOpenFailure(opened);
      }
      try {
        try {
          return fsSync.readFileSync(opened.fd);
        } catch (error) {
          throwFsSafeReadError(error, "temp workspace");
        }
      } finally {
        fsSync.closeSync(opened.fd);
      }
    },
    cleanup: () => {
      try {
        return owner.cleanupSync();
      } finally {
        unregisterTempDir();
      }
    },
    [Symbol.dispose]: () => {
      try {
        owner.cleanupSync();
      } finally {
        unregisterTempDir();
      }
    },
  };
}

export function tempWorkspaceSync(
  options: TempWorkspaceOptions,
): TempWorkspaceSync {
  return createTempWorkspaceSync(options);
}

export function withTempWorkspaceSync<T>(
  options: TempWorkspaceOptions,
  run: (workspace: TempWorkspaceSync) => T,
): T {
  const workspace = createTempWorkspaceSync(options, true);
  try {
    return run(workspace);
  } finally {
    workspace.cleanup();
  }
}
