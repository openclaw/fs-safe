import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";

export type PublishFileExclusiveSyncFailurePolicy = "rollback" | "preserve";
export type PublishFileExclusiveDirectorySyncFailure = {
  status: "failed";
  code?: string;
};
export type PublishFileExclusiveFailurePhase =
  | "copy-create"
  | "copy-verify"
  | "directory-sync"
  | "hardlink-create"
  | "hardlink-verify"
  | "rename-create"
  | "rename-verify";
export type PublishFileExclusiveCleanup = "removed" | "preserved" | "unknown";
export type PublishFileExclusiveFailureDetails = {
  phase: PublishFileExclusiveFailurePhase;
  targetCreated: boolean;
  targetIdentity?: FileIdentityStat;
  cleanup: PublishFileExclusiveCleanup;
  directorySync?: PublishFileExclusiveDirectorySyncFailure;
};

export type PublishFailureState = {
  phase: PublishFileExclusiveFailurePhase;
  targetCreated: boolean;
  targetIdentity?: FileIdentityStat;
  targetCleanupIdentity?: FileIdentityStat;
  preserveTarget: boolean;
  directorySync?: PublishFileExclusiveDirectorySyncFailure;
};

export function rememberCreatedTarget(
  state: PublishFailureState,
  identity: FileIdentityStat,
  phase: PublishFileExclusiveFailurePhase,
): void {
  state.targetCreated = true;
  state.targetIdentity = { dev: Number(identity.dev), ino: Number(identity.ino) };
  state.targetCleanupIdentity = { dev: identity.dev, ino: identity.ino };
  state.phase = phase;
}

export function publicationFailure(
  error: unknown,
  state: PublishFailureState,
  cleanup: PublishFileExclusiveCleanup,
): FsSafeError {
  const cause = error instanceof Error ? error : new Error(String(error));
  const details: PublishFileExclusiveFailureDetails = {
    phase: state.phase,
    targetCreated: state.targetCreated,
    ...(state.targetIdentity ? { targetIdentity: state.targetIdentity } : {}),
    ...(state.directorySync ? { directorySync: state.directorySync } : {}),
    cleanup,
  };
  return new FsSafeError(
    error instanceof FsSafeError ? error.code : "helper-failed",
    `exclusive file publication failed during ${state.phase}: ${cause.message}`,
    { cause, details },
  );
}

export function directorySyncFailure(
  error: unknown,
): PublishFileExclusiveDirectorySyncFailure {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? { status: "failed", code } : { status: "failed" };
}
