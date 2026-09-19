import fs, { type BigIntStats } from "node:fs";
import fsAsync from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { sameFileIdentityForCleanup } from "./file-identity.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import { hasUnsettledWindowsSecurityCommand } from "./windows-security-command.js";
import { assertDarwinCreationAcl } from "./creation-darwin.js";

export type CreationPublicationStatus = "not-published" | "published" | "indeterminate";

export function assertCreationFile(fd: number, pathname: string, expected?: BigIntStats): BigIntStats {
  const opened = inspectFileIdentitySync(() => fs.fstatSync(fd, { bigint: true }), expected);
  const named = inspectFileIdentitySync(() => fs.lstatSync(pathname, { bigint: true }), opened);
  if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || opened.nlink !== 1n || named.nlink !== 1n) {
    throw new FsSafeError("path-mismatch", "created file is not the expected single-linked regular file");
  }
  return opened;
}

export function assertPrivateCreationFile(stat: BigIntStats, fd: number): void {
  if (process.platform === "win32") return;
  if (typeof process.getuid !== "function" || stat.uid !== BigInt(process.getuid())) {
    throw new FsSafeError("not-owned", "created private file must belong to the current user");
  }
  if ((stat.mode & 0o7077n) !== 0n) {
    throw new FsSafeError("insecure-permissions", "created private file is not owner-only");
  }
  assertDarwinCreationAcl(fd);
}

function assertRecordedFile(current: BigIntStats, identity: BigIntStats): void {
  if (!current.isFile() || current.isSymbolicLink() || !sameFileIdentityForCleanup(current, identity)) {
    throw new FsSafeError("path-mismatch", "created file cleanup preserved a replacement");
  }
}

export function removeRecordedCreationFileSync(pathname: string, identity: BigIntStats, assertParent: () => void): void {
  assertParent();
  let current: BigIntStats;
  try { current = fs.lstatSync(pathname, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
    throw error;
  }
  assertRecordedFile(current, identity);
  fs.unlinkSync(pathname);
}

export async function removeRecordedCreationFile(
  pathname: string, identity: BigIntStats, assertParent: () => void,
): Promise<void> {
  assertParent();
  let current: BigIntStats;
  try { current = await fsAsync.lstat(pathname, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
    throw error;
  }
  assertParent();
  assertRecordedFile(current, identity);
  // Recheck after the awaited observation before dispatching the unlink.
  assertRecordedFile(fs.lstatSync(pathname, { bigint: true }), identity);
  await fsAsync.unlink(pathname);
}

export function creationPublicationAfterFailure(
  error: unknown, recorded: CreationPublicationStatus,
): CreationPublicationStatus {
  if (error instanceof FsSafeError) {
    const publication = error.details?.publication;
    if (publication && typeof publication === "object" && "status" in publication &&
      publication.status === "indeterminate") return "indeterminate";
  }
  return recorded;
}

export function hasPreservedCreationArtifacts(error: unknown): boolean {
  if (!(error instanceof FsSafeError)) return false;
  if (error.details?.cleanup === "preserved" || error.details?.cleanup === "failed") return true;
  const publication = error.details?.publication;
  return publication !== null && typeof publication === "object" && "status" in publication &&
    (publication.status === "published" || publication.status === "indeterminate");
}

export function rethrowPrivateStageCreationFailure(error: unknown, path: string, stageDirectory: string): never {
  if (error instanceof FsSafeError && error.code === "already-exists") {
    throw new FsSafeError("helper-failed", "private file staging path already exists", {
      cause: error, details: { publication: { status: "not-published" }, path, stageDirectory },
    });
  }
  const publication = error instanceof FsSafeError ? error.details?.publication : undefined;
  const created = error instanceof FsSafeError && error.details?.path === stageDirectory &&
    publication !== null && typeof publication === "object" && "status" in publication &&
    publication.status === "published";
  let unconfirmed = hasUnsettledWindowsSecurityCommand(error);
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    try {
      const outcome = Object.getOwnPropertyDescriptor(error, "creationOutcome");
      unconfirmed ||= Boolean(outcome && "value" in outcome && outcome.value === "unconfirmed");
    } catch { unconfirmed = true; }
  }
  if (created || unconfirmed) {
    throw privateFileSettlementFailure({
      primary: error, cleanup: [], publication: "not-published", path, stageDirectory, preserved: true,
    });
  }
  throw error;
}

export function privateFileSettlementFailure(params: {
  primary: unknown;
  cleanup: readonly unknown[];
  publication: CreationPublicationStatus;
  path: string;
  stageDirectory: string;
  preserved?: boolean;
}): FsSafeError {
  return new FsSafeError("helper-failed", "file creation or staging settlement failed", {
    cause: params.cleanup.length
      ? new AggregateError([params.primary, ...params.cleanup], "file creation and cleanup failed")
      : params.primary,
    details: {
      publication: { status: params.publication }, path: params.path, stageDirectory: params.stageDirectory,
      cleanup: params.preserved || params.publication === "indeterminate" ? "preserved" : params.cleanup.length ? "failed" : "removed",
    },
  });
}
