import type { BigIntStats } from "node:fs";
import path from "node:path";
import { inspectAtomicIdentity, type AtomicIo, type Procedure } from "./atomic-io.js";
import { FsSafeError } from "./errors.js";
import { hasErrorCode } from "./file-cleanup.js";
import { applyDirectoryMode } from "./replace-file-descriptor.js";
import type { AtomicMutation } from "./replace-file-mutation.js";

/** Retain numeric compatibility; preservation distinguishes exclusive creation from EEXIST. */
export function* prepareDirectoryMode(io: AtomicIo, params: {
  dirPath: string;
  mode: number | "preserve";
  mutation?: AtomicMutation;
  ignoreChmodError?: boolean;
}): Procedure<void> {
  if (params.mode !== "preserve") {
    params.mutation?.assert();
    yield* io.mkdir(params.dirPath, params.mode);
    yield* applyDirectoryMode(io, params);
    return;
  }
  const inspect = function* (expected?: BigIntStats): Procedure<BigIntStats> {
    const observed = inspectAtomicIdentity(io, () => io.lstatExact(params.dirPath), expected, false, stat => {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new FsSafeError("not-file", `Atomic replace parent must be a real directory: ${params.dirPath}`);
      }
    });
    return (io.asynchronous ? yield observed : observed) as BigIntStats;
  };
  let expectedIdentity: BigIntStats;
  let created = false;
  try {
    expectedIdentity = yield* inspect();
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    if (!io.asynchronous && !io.fchmodSync && process.platform !== "win32") {
      throw new TypeError("fileSystem.fchmodSync is required to finalize a created directory with dirMode: preserve");
    }
    const parent = path.dirname(params.dirPath);
    if (parent === params.dirPath) throw error;
    yield* prepareDirectoryMode(io, { ...params, dirPath: parent });
    params.mutation?.assert();
    try {
      yield* io.mkdirExclusive(params.dirPath, 0o700);
      created = true;
    } catch (mkdirError) {
      if (!hasErrorCode(mkdirError, "EEXIST")) throw mkdirError;
    }
    expectedIdentity = yield* inspect();
  }
  yield* applyDirectoryMode(io, {
    ...params,
    mode: created ? 0o700 : "preserve",
    expectedIdentity,
    // A successfully created directory must finish at 0700 even for best-effort callers.
    ignoreChmodError: created ? false : params.ignoreChmodError,
  });
  if (created && process.platform !== "win32") {
    const finalized = yield* inspect(expectedIdentity);
    if ((finalized.mode & 0o7777n) !== 0o700n) {
      throw new FsSafeError("path-mismatch", "created directory mode could not be finalized");
    }
  }
}
