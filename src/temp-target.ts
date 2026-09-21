import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { suffixWindowsReservedDeviceName } from "./filename.js";
import { sameFileIdentityForCleanup, type FileIdentityStat } from "./file-identity.js";
import { assertSafePathSegment, sanitizeSafePathSegment, trimHyphenEdges } from "./safe-path-segment.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";
import { registerTempPathForExit } from "./temp-cleanup.js";
import {
  assertNoWindowsPathAlias,
  resolvePathPreservingWindowsRoot,
} from "./windows-path-alias.js";
import type { TempWorkspaceRetainedChild as TempWorkspaceRetainedChildType } from "./temp-workspace-descriptor.js";
import type {
  TempWorkspaceCleanupOwner as TempWorkspaceCleanupOwnerType,
  TempWorkspaceCleanupSafety,
} from "./temp-workspace-owner.js";

export type TempFile = {
  dir: string;
  path: string;
  file(fileName?: string): string;
  cleanup: () => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

type TempFileOptions = {
  rootDir?: string;
  prefix: string;
  fileName?: string;
  onCleanupError?: (error: unknown) => void;
  cleanupSafety?: TempWorkspaceCleanupSafety;
};

const HYPHEN_CHAR_CODE = 0x2d;
const DOT_CHAR_CODE = 0x2e;
const NUMBER_ZERO_CHAR_CODE = 0x30;
const NUMBER_NINE_CHAR_CODE = 0x39;
const UPPERCASE_A_CHAR_CODE = 0x41;
const UPPERCASE_Z_CHAR_CODE = 0x5a;
const UNDERSCORE_CHAR_CODE = 0x5f;
const LOWERCASE_A_CHAR_CODE = 0x61;
const LOWERCASE_Z_CHAR_CODE = 0x7a;

function isExtensionCharCode(charCode: number): boolean {
  return (
    (charCode >= NUMBER_ZERO_CHAR_CODE && charCode <= NUMBER_NINE_CHAR_CODE) ||
    (charCode >= UPPERCASE_A_CHAR_CODE && charCode <= UPPERCASE_Z_CHAR_CODE) ||
    (charCode >= LOWERCASE_A_CHAR_CODE && charCode <= LOWERCASE_Z_CHAR_CODE) ||
    charCode === DOT_CHAR_CODE ||
    charCode === UNDERSCORE_CHAR_CODE ||
    charCode === HYPHEN_CHAR_CODE
  );
}

function trailingExtensionChars(value: string): string {
  let start = value.length;
  while (start > 0 && isExtensionCharCode(value.charCodeAt(start - 1))) {
    start -= 1;
  }
  return start === value.length ? "" : value.slice(start);
}

function trimLeadingExtensionPunctuation(value: string): string {
  let start = 0;
  while (start < value.length) {
    const charCode = value.charCodeAt(start);
    if (
      charCode !== DOT_CHAR_CODE &&
      charCode !== UNDERSCORE_CHAR_CODE &&
      charCode !== HYPHEN_CHAR_CODE
    ) {
      break;
    }
    start += 1;
  }
  return start === 0 ? value : value.slice(start);
}

function sanitizePrefix(prefix: string): string {
  const normalized = trimHyphenEdges(prefix.replace(/[^a-zA-Z0-9_-]+/g, "-"));
  return normalized || "tmp";
}

function sanitizeExtension(extension?: string): string {
  if (!extension) {
    return "";
  }
  const normalized = extension.startsWith(".") ? extension : `.${extension}`;
  const suffix = trailingExtensionChars(normalized);
  const token = trimLeadingExtensionPunctuation(suffix);
  return token ? `.${token}` : "";
}

export function sanitizeTempFileName(fileName: string): string {
  return suffixWindowsReservedDeviceName(
    sanitizeSafePathSegment(path.basename(fileName)) ?? "download.bin",
  );
}

export function buildRandomTempFilePath(params: {
  rootDir?: string;
  prefix: string;
  extension?: string;
  now?: number;
  uuid?: string;
}): string {
  const rootDir = resolveTempRoot(params.rootDir);
  const prefix = sanitizePrefix(params.prefix);
  const extension = sanitizeExtension(params.extension);
  const nowCandidate = params.now;
  const now =
    typeof nowCandidate === "number" && Number.isFinite(nowCandidate)
      ? Math.trunc(nowCandidate)
      : Date.now();
  const uuid = params.uuid
    ? assertSafePathSegment(params.uuid.trim(), { label: "temp uuid" })
    : crypto.randomUUID();
  const filePath = path.join(rootDir, `${prefix}-${now}-${uuid}${extension}`);
  assertNoWindowsPathAlias(filePath, "filesystem", "temp file path uses a Windows filesystem namespace alias");
  return filePath;
}

function isNodeErrorWithCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === code
  );
}

async function cleanupTempDir(
  dir: string,
  identity: FileIdentityStat,
  onCleanupError?: (error: unknown) => void,
) {
  try {
    const current = fsSync.lstatSync(dir, { bigint: true });
    if (!current || !sameFileIdentityForCleanup(current, identity)) {
      return;
    }
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    if (!isNodeErrorWithCode(err, "ENOENT")) {
      onCleanupError?.(err);
    }
  }
}

function resolveTempRoot(rootDir?: string): string {
  if (rootDir !== undefined) {
    assertNoWindowsPathAlias(rootDir, "filesystem", "temp root uses a Windows filesystem namespace alias");
  }
  const selectedRoot = rootDir ?? resolveSecureTempRoot({ fallbackPrefix: "fs-safe" });
  assertNoWindowsPathAlias(selectedRoot, "filesystem", "temp root uses a Windows filesystem namespace alias");
  const resolvedRoot = resolvePathPreservingWindowsRoot(selectedRoot);
  assertNoWindowsPathAlias(resolvedRoot, "filesystem", "temp root uses a Windows filesystem namespace alias");
  return resolvedRoot;
}

function resolveTempFileCleanupSafety(
  value: TempWorkspaceCleanupSafety | undefined,
): TempWorkspaceCleanupSafety {
  if (value === undefined || value === "compatible") return "compatible";
  if (value === "require-bounded") return value;
  throw new TypeError("cleanupSafety must be compatible or require-bounded");
}

export async function createOwnedTempFile(params: TempFileOptions): Promise<{
  target: TempFile;
  identity: Readonly<Pick<fsSync.BigIntStats, "dev" | "ino">>;
}> {
  const cleanupSafety = resolveTempFileCleanupSafety(params.cleanupSafety);
  const rootDir = resolveTempRoot(params.rootDir);
  const prefix = `${sanitizePrefix(params.prefix)}-`;
  if (cleanupSafety === "require-bounded") {
    const initialFileName = sanitizeTempFileName(params.fileName ?? "download.bin");
    const [
      { TempWorkspaceCleanupCapability, TempWorkspaceCleanupOwner, throwTempWorkspaceCreationFailure },
      { admitExistingTempWorkspaceRoot },
      { TempWorkspaceRetainedChild },
      { validateInitialTempWorkspaceChild },
      { inspectDirectoryIdentitySync },
    ] = await Promise.all([
      import("./temp-workspace-owner.js"),
      import("./temp-workspace-admission.js"),
      import("./temp-workspace-descriptor.js"),
      import("./temp-workspace-child-admission.js"),
      import("./directory-guard.js"),
    ]);
    const admission = admitExistingTempWorkspaceRoot(rootDir);
    const childPrefix = path.join(admission.dir, prefix);
    assertNoWindowsPathAlias(childPrefix, "filesystem", "temp directory uses a Windows filesystem namespace alias");
    const capability = new TempWorkspaceCleanupCapability(
      admission.dir, cleanupSafety, admission, 0o700,
    );
    let dir: string;
    let initialPath: string;
    let identity: Readonly<Pick<fsSync.BigIntStats, "dev" | "ino">>;
    let retainedChild: TempWorkspaceRetainedChildType | undefined;
    let cleanupOwner: TempWorkspaceCleanupOwnerType | undefined;
    let unregisterTempDir: () => void;
    try {
      capability.prepareChildCreation();
      dir = await fs.mkdtemp(childPrefix);
      assertNoWindowsPathAlias(dir, "filesystem", "temp directory uses a Windows filesystem namespace alias");
      initialPath = path.join(dir, initialFileName);
      assertNoWindowsPathAlias(initialPath, "filesystem", "temp file path uses a Windows filesystem namespace alias");
      capability.assertCurrent();
      const initial = inspectDirectoryIdentitySync(dir);
      identity = Object.freeze({ dev: initial.dev, ino: initial.ino });
      const needsModeInitialization = validateInitialTempWorkspaceChild(
        initial, admission.ownerUid, 0o700,
      );
      retainedChild = TempWorkspaceRetainedChild.retain(dir, identity);
      if (needsModeInitialization) {
        await retainedChild.initializeMode(0o700, admission.ownerUid, admission.assertCurrent);
      }
      const retainDescriptor = capability.admitChildDescriptor(retainedChild.ensureReadable());
      capability.assertAncestryCurrent();
      retainedChild.finalizeAdmission(admission.ownerUid, 0o700);
      cleanupOwner = new TempWorkspaceCleanupOwner(retainedChild, capability, retainDescriptor);
      retainedChild = undefined;
      unregisterTempDir = registerTempPathForExit(dir, {
        cleanupSync: () => cleanupOwner!.cleanupSync(),
      });
    } catch (error) {
      return throwTempWorkspaceCreationFailure(error, retainedChild, capability, cleanupOwner, "temp file");
    }
    const owner = cleanupOwner!;
    const file = (fileName?: string) => {
      const filePath = path.join(dir, sanitizeTempFileName(fileName ?? params.fileName ?? "download.bin"));
      assertNoWindowsPathAlias(filePath, "filesystem", "temp file path uses a Windows filesystem namespace alias");
      return filePath;
    };
    const cleanup = async () => {
      try {
        try {
          await owner.cleanup();
        } catch (err) {
          if (!isNodeErrorWithCode(err, "ENOENT")) {
            params.onCleanupError?.(err);
          }
        }
      } finally {
        unregisterTempDir();
      }
    };
    return {
      target: {
        dir,
        path: initialPath,
        file,
        cleanup,
        [Symbol.asyncDispose]: cleanup,
      },
      identity,
    };
  }
  const dir = await fs.mkdtemp(path.join(rootDir, prefix));
  assertNoWindowsPathAlias(dir, "filesystem", "temp directory uses a Windows filesystem namespace alias");
  // Windows file indexes can exceed Number.MAX_SAFE_INTEGER. Cleanup receipts
  // must retain the exact identity or adjacent directories can compare equal.
  const identity = fsSync.lstatSync(dir, { bigint: true });
  const unregisterTempDir = registerTempPathForExit(dir, { recursive: true, identity });
  const file = (fileName?: string) => {
    const filePath = path.join(dir, sanitizeTempFileName(fileName ?? params.fileName ?? "download.bin"));
    assertNoWindowsPathAlias(filePath, "filesystem", "temp file path uses a Windows filesystem namespace alias");
    return filePath;
  };
  const cleanup = async () => {
    try {
      await cleanupTempDir(dir, identity, params.onCleanupError);
    } finally {
      unregisterTempDir();
    }
  };
  return {
    target: {
      dir,
      path: file(),
      file,
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    },
    identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
  };
}

export async function tempFile(params: TempFileOptions): Promise<TempFile> {
  return (await createOwnedTempFile(params)).target;
}

export async function withTempFile<T>(
  params: TempFileOptions,
  fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
  const target = await tempFile(params);
  try {
    return await fn(target.path);
  } finally {
    await target.cleanup();
  }
}
