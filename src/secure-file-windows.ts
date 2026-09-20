import type { BigIntStats, Stats } from "node:fs";

import { FsSafeError } from "./errors.js";
import { recordFileObservationFailure } from "./file-observation.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import type { PermissionCheck } from "./permissions.js";
import { inspectWindowsDescriptorCommand } from "./windows-security-command.js";
import { validateSecureWindowsSecurityFacts } from "./windows-security-facts.js";

const IDENTITY_RE = /^([0-9a-f]{8}):([0-9a-f]{16})$/;
const TRUSTED_OWNER_CLASSES = new Set(["current-user", "system", "administrators"]);

type ExactIdentity = Pick<BigIntStats, "dev" | "ino">;

function permissionUnverified(message: string, cause?: unknown): never {
  throw new FsSafeError("permission-unverified", message, cause === undefined ? {} : { cause });
}

function identityMismatch(): never {
  const error = new FsSafeError("path-mismatch", "file identity changed or could not be verified");
  recordFileObservationFailure(error, "identity");
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseIdentity(value: unknown): ExactIdentity {
  if (typeof value !== "string") identityMismatch();
  const match = IDENTITY_RE.exec(value);
  if (!match) identityMismatch();
  return {
    dev: BigInt(`0x${match[1]}`),
    ino: BigInt(`0x${match[2]}`),
  };
}

function inspectDescriptorResult(params: {
  identity: ExactIdentity;
  stat: Stats;
}, result: unknown, mechanism: "native" | "system-command"): PermissionCheck {
  if (!isRecord(result)) permissionUnverified("Windows descriptor ACL facts were malformed");
  const observed = parseIdentity(result.identity);
  if (observed.dev !== params.identity.dev || observed.ino !== params.identity.ino) {
    identityMismatch();
  }
  const facts = validateSecureWindowsSecurityFacts(result.security);
  return {
    ok: true,
    isSymlink: false,
    isDir: params.stat.isDirectory(),
    mode: typeof params.stat.mode === "number" ? params.stat.mode : null,
    bits: null,
    source: "windows-acl",
    worldWritable: facts.worldWritable,
    groupWritable: facts.groupWritable,
    worldReadable: facts.worldReadable,
    groupReadable: facts.groupReadable,
    ownerSid: facts.ownerSid,
    ownerTrusted: TRUSTED_OWNER_CLASSES.has(facts.ownerClass),
    aclSummary:
      `${mechanism} descriptor owner=${facts.ownerClass} world=` +
      `${facts.worldReadable ? "r" : "-"}${facts.worldWritable ? "w" : "-"} ` +
      `group=${facts.groupReadable ? "r" : "-"}${facts.groupWritable ? "w" : "-"}`,
  };
}

/** Both mechanisms inspect the same borrowed handle; the caller owns its lifetime. */
export async function inspectSecureWindowsFile(params: {
  fd: number;
  identity: ExactIdentity;
  stat: Stats;
}): Promise<PermissionCheck> {
  let native;
  try { native = getNativeBinding(); } catch (cause) {
    permissionUnverified("Windows descriptor ACL verification requires the matching native helper", cause);
  }
  const inspect = native?.inspectWindowsSecureFileHandle;
  const nativeAvailable = typeof inspect === "function";
  if (!nativeAvailable && getFsSafeNativeConfig().mode === "require") {
    permissionUnverified("Windows descriptor ACL verification requires an up-to-date native helper");
  }
  if (!nativeAvailable) {
    warnNativeFallback("windows-secure-file", "Windows descriptor ACL inspection uses a slower built-in system command.");
  }
  let result: unknown;
  try {
    if (nativeAvailable) {
      result = inspect.call(native, params.fd);
    } else {
      result = await inspectWindowsDescriptorCommand(params.fd);
    }
  } catch (cause) {
    permissionUnverified("Windows descriptor ACL verification failed", cause);
  }
  return inspectDescriptorResult(params, result, nativeAvailable ? "native" : "system-command");
}
