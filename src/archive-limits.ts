import { Transform } from "node:stream";

export type ArchiveExtractLimits = {
  /**
   * Max archive file bytes (compressed).
   */
  maxArchiveBytes?: number;
  /** Max number of extracted entries (files + dirs). */
  maxEntries?: number;
  /** Max extracted bytes (sum of all files). */
  maxExtractedBytes?: number;
  /** Max extracted bytes for a single file entry. */
  maxEntryBytes?: number;
  /** Max bytes in one PAX, GNU long-name, or related TAR metadata entry. */
  maxMetaEntryBytes?: number;
  /** Max path components in one extracted entry after stripComponents. */
  maxEntryPathComponents?: number;
};

export const DEFAULT_MAX_ARCHIVE_BYTES_ZIP = 256 * 1024 * 1024;
export const DEFAULT_MAX_ENTRIES = 50_000;
export const DEFAULT_MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_META_ENTRY_BYTES = 1024 * 1024;
export const DEFAULT_MAX_ENTRY_PATH_COMPONENTS = 256;

export const ARCHIVE_LIMIT_ERROR_CODE = {
  ARCHIVE_SIZE_EXCEEDS_LIMIT: "archive-size-exceeds-limit",
  ENTRY_COUNT_EXCEEDS_LIMIT: "archive-entry-count-exceeds-limit",
  ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-entry-extracted-size-exceeds-limit",
  EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-extracted-size-exceeds-limit",
  META_ENTRY_SIZE_EXCEEDS_LIMIT: "archive-meta-entry-size-exceeds-limit",
  MANIFEST_SIZE_EXCEEDS_LIMIT: "archive-manifest-size-exceeds-limit",
  ENTRY_PATH_COMPONENTS_EXCEEDS_LIMIT: "archive-entry-path-components-exceeds-limit",
} as const;

export type ArchiveLimitErrorCode =
  (typeof ARCHIVE_LIMIT_ERROR_CODE)[keyof typeof ARCHIVE_LIMIT_ERROR_CODE];

const ARCHIVE_LIMIT_ERROR_MESSAGE = {
  [ARCHIVE_LIMIT_ERROR_CODE.ARCHIVE_SIZE_EXCEEDS_LIMIT]: "archive size exceeds limit",
  [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT]: "archive entry count exceeds limit",
  [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT]:
    "archive entry extracted size exceeds limit",
  [ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT]: "archive extracted size exceeds limit",
  [ARCHIVE_LIMIT_ERROR_CODE.META_ENTRY_SIZE_EXCEEDS_LIMIT]:
    "archive metadata entry size exceeds limit",
  [ARCHIVE_LIMIT_ERROR_CODE.MANIFEST_SIZE_EXCEEDS_LIMIT]:
    "archive manifest size exceeds limit",
  [ARCHIVE_LIMIT_ERROR_CODE.ENTRY_PATH_COMPONENTS_EXCEEDS_LIMIT]:
    "archive entry path components exceed limit",
} as const satisfies Record<ArchiveLimitErrorCode, string>;

export class ArchiveLimitError extends Error {
  readonly code: ArchiveLimitErrorCode;

  constructor(code: ArchiveLimitErrorCode) {
    super(ARCHIVE_LIMIT_ERROR_MESSAGE[code]);
    this.name = "ArchiveLimitError";
    this.code = code;
  }
}

export type ResolvedArchiveExtractLimits = Required<ArchiveExtractLimits>;

function clampLimit(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const v = Math.floor(value);
  return v >= 0 ? v : undefined;
}

export function resolveExtractLimits(
  limits?: ArchiveExtractLimits,
): ResolvedArchiveExtractLimits {
  // Defaults: defensive, but should not break normal installs.
  return {
    maxArchiveBytes: clampLimit(limits?.maxArchiveBytes) ?? DEFAULT_MAX_ARCHIVE_BYTES_ZIP,
    maxEntries: clampLimit(limits?.maxEntries) ?? DEFAULT_MAX_ENTRIES,
    maxExtractedBytes: clampLimit(limits?.maxExtractedBytes) ?? DEFAULT_MAX_EXTRACTED_BYTES,
    maxEntryBytes: clampLimit(limits?.maxEntryBytes) ?? DEFAULT_MAX_ENTRY_BYTES,
    maxMetaEntryBytes:
      clampLimit(limits?.maxMetaEntryBytes) ?? DEFAULT_MAX_META_ENTRY_BYTES,
    maxEntryPathComponents:
      clampLimit(limits?.maxEntryPathComponents) ?? DEFAULT_MAX_ENTRY_PATH_COMPONENTS,
  };
}

export function assertArchiveEntryPathComponentsWithinLimit(
  entryPath: string,
  limits: ResolvedArchiveExtractLimits,
): void {
  const components = entryPath
    .split(/[\\/]+/u)
    .filter((component) => component.length > 0 && component !== ".").length;
  if (components > limits.maxEntryPathComponents) {
    throw new ArchiveLimitError(
      ARCHIVE_LIMIT_ERROR_CODE.ENTRY_PATH_COMPONENTS_EXCEEDS_LIMIT,
    );
  }
}

export function assertArchiveEntryCountWithinLimit(
  entryCount: number,
  limits: ResolvedArchiveExtractLimits,
) {
  if (entryCount > limits.maxEntries) {
    throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT);
  }
}

export function createByteBudgetTracker(limits: ResolvedArchiveExtractLimits): {
  startEntry: () => void;
  addBytes: (bytes: number) => void;
  addEntrySize: (size: number) => void;
} {
  let entryBytes = 0;
  let extractedBytes = 0;

  const addBytes = (bytes: number) => {
    const b = Math.max(0, Math.floor(bytes));
    if (b === 0) {
      return;
    }
    entryBytes += b;
    if (entryBytes > limits.maxEntryBytes) {
      throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
    }
    extractedBytes += b;
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.EXTRACTED_SIZE_EXCEEDS_LIMIT);
    }
  };

  return {
    startEntry() {
      entryBytes = 0;
    },
    addBytes,
    addEntrySize(size: number) {
      const s = Math.max(0, Math.floor(size));
      if (s > limits.maxEntryBytes) {
        throw new ArchiveLimitError(ARCHIVE_LIMIT_ERROR_CODE.ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT);
      }
      // Tar budgets are based on the header-declared size.
      addBytes(s);
    },
  };
}

export function createExtractBudgetTransform(params: {
  onChunkBytes: (bytes: number) => void;
}): Transform {
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk as Uint8Array);
        params.onChunkBytes(buf.byteLength);
        callback(null, buf);
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}
