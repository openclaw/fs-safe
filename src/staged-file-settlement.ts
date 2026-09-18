import type { BigIntStats } from "node:fs";
import { FsSafeError } from "./errors.js";
import type {
  StagedFileCleanupReceipt,
  StagedFileFailureDetails,
  StagedFilePublication,
  StagedFileReceipt,
} from "./staged-file-types.js";

export function createStagedFileReceipt(
  directory: StagedFileReceipt["directory"],
  temporaryBasename: string,
  stat: BigIntStats,
): StagedFileReceipt {
  return Object.freeze({
    directory,
    temporaryBasename,
    identity: Object.freeze({
      dev: stat.dev, ino: stat.ino, mode: Number(stat.mode & 0o7777n),
      nlink: stat.nlink, size: stat.size, uid: Number(stat.uid), gid: Number(stat.gid),
      mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
    }),
  });
}

export function stagedFileFailure(error: unknown, details: StagedFileFailureDetails): FsSafeError {
  const code = error instanceof FsSafeError
    ? error.code
    : (error as NodeJS.ErrnoException)?.code === "EEXIST" ? "already-exists" : "helper-failed";
  return new FsSafeError(code, `staged file ${details.phase} failed`, { cause: error, details });
}

/** Finish owned cleanup and every close before surfacing publication evidence. */
export async function settleStagedFile(params: {
  temporaryBasename: string;
  publication: StagedFilePublication;
  phase: StagedFileFailureDetails["phase"];
  failure?: { error: unknown };
  cleanup: () => Promise<StagedFileCleanupReceipt["status"]>;
  close: readonly (() => Promise<void> | void)[];
}): Promise<void> {
  const errors = params.failure ? [params.failure.error] : [];
  let status: StagedFileCleanupReceipt["status"];
  try {
    status = await params.cleanup();
  } catch (error) {
    status = "failed";
    errors.push(error);
  }
  let resources: StagedFileCleanupReceipt["resources"] = "closed";
  for (const close of params.close) {
    try {
      await close();
    } catch (error) {
      resources = "close-failed";
      errors.push(error);
    }
  }
  const incomplete = status === "failed" || status === "preserved" || resources === "close-failed";
  // A settled pre-publication failure retains the producer/authority rejection exactly.
  if (!incomplete && (!params.failure || params.publication.status === "not-published")) return;
  const error = errors.length > 1 ? new AggregateError(errors, "staged operation and settlement failed")
    : errors.length === 1 ? errors[0] : new FsSafeError("not-removable", "staged cleanup preserved an unverified entry");
  const cleanup: StagedFileCleanupReceipt = Object.freeze({
    temporaryBasename: params.temporaryBasename,
    publication: params.publication,
    status,
    resources,
  });
  throw stagedFileFailure(error, {
    phase: params.failure ? params.phase : "cleanup",
    publication: params.publication,
    cleanup,
  });
}
