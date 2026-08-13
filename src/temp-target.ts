import crypto from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { sameFileIdentityForCleanup, type FileIdentityStat } from "./file-identity.js";
import { assertSafePathSegment, sanitizeSafePathSegment } from "./safe-path-segment.js";
import { resolveSecureTempRoot } from "./secure-temp-dir.js";
import { registerTempPathForExit } from "./temp-cleanup.js";

export type TempFile = {
  dir: string;
  path: string;
  file(fileName?: string): string;
  cleanup: () => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
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

function trimHyphenEdges(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === HYPHEN_CHAR_CODE) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === HYPHEN_CHAR_CODE) {
    end -= 1;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

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
  return sanitizeSafePathSegment(path.basename(fileName), "download.bin", {
    allowDotPrefix: true,
  });
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
  return path.join(rootDir, `${prefix}-${now}-${uuid}${extension}`);
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
    const current = await lstat(dir).catch((error: unknown) => {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (!current || !sameFileIdentityForCleanup(current, identity)) {
      return;
    }
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    if (!isNodeErrorWithCode(err, "ENOENT")) {
      onCleanupError?.(err);
    }
  }
}

function resolveTempRoot(rootDir?: string): string {
  return path.resolve(rootDir ?? resolveSecureTempRoot({ fallbackPrefix: "fs-safe" }));
}

export async function tempFile(params: {
  rootDir?: string;
  prefix: string;
  fileName?: string;
  onCleanupError?: (error: unknown) => void;
}): Promise<TempFile> {
  const rootDir = resolveTempRoot(params.rootDir);
  const prefix = `${sanitizePrefix(params.prefix)}-`;
  const dir = await mkdtemp(path.join(rootDir, prefix));
  const identity = await lstat(dir);
  const unregisterTempDir = registerTempPathForExit(dir, { recursive: true, identity });
  const file = (fileName?: string) =>
    path.join(dir, sanitizeTempFileName(fileName ?? params.fileName ?? "download.bin"));
  const cleanup = async () => {
    try {
      await cleanupTempDir(dir, identity, params.onCleanupError);
    } finally {
      unregisterTempDir();
    }
  };
  return {
    dir,
    path: file(),
    file,
    cleanup,
    [Symbol.asyncDispose]: cleanup,
  };
}

export async function withTempFile<T>(
  params: {
    rootDir?: string;
    prefix: string;
    fileName?: string;
    onCleanupError?: (error: unknown) => void;
  },
  fn: (tmpPath: string) => Promise<T>,
): Promise<T> {
  const target = await tempFile(params);
  try {
    return await fn(target.path);
  } finally {
    await target.cleanup();
  }
}
