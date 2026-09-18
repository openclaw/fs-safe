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
  type TempWorkspaceRootAdmission,
} from "./temp-workspace-admission.js";
import { validateTempWorkspaceDirMode } from "./temp-workspace-permissions.js";
import type { TempWorkspaceOptions, TempWorkspace, TempWorkspaceSync } from "./temp-workspace-types.js";

export type {
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

function tempWorkspaceSettings(options: TempWorkspaceOptions) {
  const rootDir = options.rootDir;
  assertNoWindowsPathAlias(rootDir, "filesystem", "temp workspace root uses a Windows filesystem namespace alias");
  const dirMode = options.dirMode ?? 0o700;
  validateTempWorkspaceDirMode(dirMode);
  const mode = options.mode ?? 0o600;
  const cleanupSafety = resolveTempWorkspaceCleanupSafety(options.cleanupSafety);
  return { rootDir, dirMode, mode, cleanupSafety };
}

function tempWorkspaceChildPrefix(root: string, options: TempWorkspaceOptions, scopedPrefix: boolean): string {
  assertNoWindowsPathAlias(root, "filesystem", "temp workspace root uses a Windows filesystem namespace alias");
  // Capture and sanitize caller-controlled data before retaining descriptors.
  const prefix = options.prefix;
  const workspacePrefix = scopedPrefix ? `${sanitizeTempPrefix(prefix)}${randomUUID()}-` : prefix;
  const childPrefix = path.join(root, sanitizeTempPrefix(workspacePrefix));
  assertNoWindowsPathAlias(childPrefix, "filesystem", "temp workspace path uses a Windows filesystem namespace alias");
  return childPrefix;
}

function throwTempWorkspaceCreationFailure(
  error: unknown,
  retainedChild: TempWorkspaceRetainedChild | undefined,
  capability: TempWorkspaceCleanupCapability,
  owner?: TempWorkspaceCleanupOwner,
): never {
  try {
    if (owner) owner.cleanupSync();
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

function registerTempWorkspace(
  dir: string,
  retainedChild: TempWorkspaceRetainedChild,
  capability: TempWorkspaceCleanupCapability,
  admission: TempWorkspaceRootAdmission,
  dirMode: number,
) {
  let owner: TempWorkspaceCleanupOwner | undefined;
  let stat: BigIntStats | Stats;
  let unregisterTempDir: () => void;
  try {
    const retainChildDescriptor = capability.admitChildDescriptor(retainedChild.ensureReadable());
    // Final adoption orders ancestry and cleanup-parent authority before the
    // original child's descriptor and named security-state checks.
    if (capability.parent) capability.assertAncestryCurrent();
    else admission.assertAncestry();
    stat = retainedChild.finalizeAdmission(admission.ownerUid, dirMode);
    owner = new TempWorkspaceCleanupOwner(retainedChild, capability, retainChildDescriptor);
    unregisterTempDir = registerTempPathForExit(dir, { cleanupSync: () => owner!.cleanupSync() });
  } catch (error) {
    throwTempWorkspaceCreationFailure(error, retainedChild, capability, owner);
  }
  return { owner: owner!, unregisterTempDir, identity: { dev: Number(stat.dev), ino: Number(stat.ino) } };
}

async function createTempWorkspace(
  options: TempWorkspaceOptions,
  scopedPrefix = false,
): Promise<TempWorkspace> {
  const { rootDir, dirMode, mode, cleanupSafety } = tempWorkspaceSettings(options);
  const admission = await admitTempWorkspaceRoot(rootDir);
  const root = admission.dir;
  const childPrefix = tempWorkspaceChildPrefix(root, options, scopedPrefix);
  const capability = new TempWorkspaceCleanupCapability(root, cleanupSafety, admission, dirMode);
  let dir: string;
  let retainedChild: TempWorkspaceRetainedChild | undefined;
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
    const stat = inspectDirectoryIdentitySync(dir);
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
  } catch (error) {
    throwTempWorkspaceCreationFailure(error, retainedChild, capability);
  }
  const { owner, identity, unregisterTempDir } = registerTempWorkspace(
    dir, retainedChild, capability, admission, dirMode,
  );
  // Once registered, even a store-construction failure remains exit-cleanable.
  const store = fileStore({ rootDir: dir, private: true, dirMode, mode });

  return {
    dir,
    identity,
    store,
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
  const { rootDir, dirMode, mode, cleanupSafety } = tempWorkspaceSettings(options);
  const admission = admitTempWorkspaceRootSync(rootDir);
  const root = admission.dir;
  const childPrefix = tempWorkspaceChildPrefix(root, options, scopedPrefix);
  const capability = new TempWorkspaceCleanupCapability(root, cleanupSafety, admission, dirMode);
  let dir: string;
  let retainedChild: TempWorkspaceRetainedChild | undefined;
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
    let stat: BigIntStats;
    if (directRequestedMode) {
      const created = TempWorkspaceRetainedChild.retainCreated(dir);
      retainedChild = created.retained;
      stat = created.stat;
    } else {
      stat = inspectDirectoryIdentitySync(dir);
    }
    const needsModeInitialization = validateInitialTempWorkspaceChild(stat, admission.ownerUid, dirMode);
    retainedChild ??= TempWorkspaceRetainedChild.retain(dir, stat);
    admitRetainedTempWorkspaceChildSync(
      retainedChild,
      needsModeInitialization,
      admission,
      dirMode,
    );
  } catch (error) {
    throwTempWorkspaceCreationFailure(error, retainedChild, capability);
  }
  const { owner, identity, unregisterTempDir } = registerTempWorkspace(
    dir, retainedChild, capability, admission, dirMode,
  );
  // Once registered, even a store-construction failure remains exit-cleanable.
  const store = fileStoreSync({ rootDir: dir, private: true, dirMode, mode });

  return {
    dir,
    identity,
    store,
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
