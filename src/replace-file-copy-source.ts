import type { BigIntStats, Stats } from "node:fs";
import { inspectAtomicIdentity, type AtomicIo, type Procedure } from "./atomic-io.js";
import { resolveReadOpenFlags } from "./read-open-flags.js";
import { FsSafeError } from "./errors.js";
import { hasErrorCode } from "./file-cleanup.js";

const OPEN_READ_FLAGS = resolveReadOpenFlags();

function assertSourcePreview(source: Stats, src: string): void {
  if (source.isSymbolicLink()) {
    throw new FsSafeError("symlink", `Refusing copy fallback from non-file source: ${src}`);
  }
  if (!source.isFile()) {
    throw new FsSafeError("not-file", `Refusing copy fallback from non-file source: ${src}`);
  }
  if (source.nlink !== 1) {
    throw new FsSafeError("hardlink", `Hardlinked copy fallback source not allowed: ${src}`);
  }
}

function assertOpenedSource(opened: BigIntStats, current: BigIntStats, src: string): void {
  if (!opened.isFile() || current.isSymbolicLink()) {
    throw new FsSafeError("path-mismatch", `Copy fallback source changed while opening: ${src}`);
  }
  if (opened.nlink !== 1n) {
    throw new FsSafeError("hardlink", `Hardlinked copy fallback source not allowed: ${src}`);
  }
}

export function* readOwnedCopySource(io: AtomicIo, params: {
  src: string;
  expectedIdentity?: BigIntStats;
}): Procedure<{ replacement: Buffer; mode: number }> {
  assertSourcePreview(yield* io.lstat(params.src), params.src);
  const handle = yield* openSource(io, params.src);
  try {
    const opened = yield* inspectAtomicIdentity(io, () => handle.statExact(), params.expectedIdentity);
    const current = yield* inspectAtomicIdentity(io, () => io.lstatExact(params.src), opened);
    assertOpenedSource(opened, current, params.src);
    const replacement = yield* handle.readFile(io.asynchronous ? undefined : Number(opened.size));
    return { replacement, mode: Number(opened.mode) };
  } finally {
    try {
      yield* handle.close();
    } catch {
      // Source close never replaces the selected read or admission result.
    }
  }
}

function* openSource(io: AtomicIo, src: string) {
  try {
    return yield* io.open(src, OPEN_READ_FLAGS);
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) {
      throw new FsSafeError("symlink", `Refusing copy fallback from non-file source: ${src}`, {
        cause: error,
      });
    }
    throw error;
  }
}
