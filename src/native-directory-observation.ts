import path from "node:path";
import { FsSafeError } from "./errors.js";
import { getNativeBinding, type NativeBinding } from "./native.js";
import type { NativeDirectoryObservation } from "./native-binding.js";
import { inspectFileIdentitySync } from "./strict-file-identity.js";
import type { ExactStatIdentity } from "./stat-observation.js";

export type NativeDirectoryObservationBackend = NativeBinding & {
  observeDirectory(pathname: string): NativeDirectoryObservation;
};

export type NativeDirectoryObservationGuard = NativeDirectoryObservation & {
  dir: string;
  identity: ExactStatIdentity;
  nativeDirectoryObservation: true;
};

export function getNativeDirectoryObservationBackend(
  enabled = true,
): NativeDirectoryObservationBackend | undefined {
  if (!enabled) return undefined;
  const binding = getNativeBinding();
  return binding && typeof binding.observeDirectory === "function"
    ? binding as NativeDirectoryObservationBackend
    : undefined;
}

function validateNativeDirectoryObservation(
  observation: NativeDirectoryObservation,
): NativeDirectoryObservation {
  if (!observation || typeof observation.dev !== "bigint" || observation.dev < 0n ||
    typeof observation.ino !== "bigint" || observation.ino < 0n ||
    typeof observation.realPath !== "string" ||
    observation.realPath.includes("\0") ||
    (!path.isAbsolute(observation.realPath) && !path.win32.isAbsolute(observation.realPath))) {
    throw new FsSafeError("path-mismatch", "native directory observation is invalid");
  }
  return observation;
}

/** Exact identity, type, and canonical path captured from one retained handle. */
export function inspectNativeDirectoryObservation(
  backend: NativeDirectoryObservationBackend,
  pathname: string,
  expected?: ExactStatIdentity,
  platform: NodeJS.Platform = process.platform,
): NativeDirectoryObservation {
  return inspectFileIdentitySync(
    () => validateNativeDirectoryObservation(backend.observeDirectory(pathname)),
    expected,
    platform,
  );
}

export function extendNativeDirectoryObservationGuard(
  observation: NativeDirectoryObservation,
  dir: string,
): NativeDirectoryObservationGuard {
  const guard = observation as NativeDirectoryObservationGuard;
  guard.dir = dir;
  guard.identity = guard;
  guard.nativeDirectoryObservation = true;
  return guard;
}

export function isNativeDirectoryObservationGuard(
  guard: unknown,
): guard is NativeDirectoryObservationGuard {
  return typeof guard === "object" && guard !== null &&
    (guard as Partial<NativeDirectoryObservationGuard>).nativeDirectoryObservation === true;
}
