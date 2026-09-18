import type { BigIntStats, Stats } from "node:fs";

import { FsSafeError } from "./errors.js";
import { recordFileObservationFailure } from "./file-observation.js";
import type {
  NativeWindowsAccessControlEntry,
  NativeWindowsSecurityFacts,
} from "./native-binding.js";
import { getNativeBinding } from "./native.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import type { PermissionCheck } from "./permissions.js";
import { inspectWindowsDescriptorCommand } from "./windows-security-command.js";

const IDENTITY_RE = /^([0-9a-f]{8}):([0-9a-f]{16})$/;
const SID_RE = /^s-\d+-\d+(?:-\d+)+$/;
const OWNER_CLASSES = new Set(["current-user", "system", "administrators", "foreign"]);
const TRUSTED_OWNER_CLASSES = new Set(["current-user", "system", "administrators"]);
const SYSTEM_SID = "s-1-5-18";
const ADMINISTRATORS_SID = "s-1-5-32-544";
const WORLD_SIDS = new Set([
  "s-1-1-0", "s-1-5-11", "s-1-5-32-545", "s-1-5-7",
  "s-1-5-32-546", "s-1-5-4", "s-1-5-2",
]);

const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const GENERIC_ALL = 0x1000_0000;
const DELETE_ACCESS = 0x0001_0000;
const WRITE_DAC = 0x0004_0000;
const WRITE_OWNER = 0x0008_0000;
const FILE_READ_DATA = 0x0000_0001;
const FILE_WRITE_DATA = 0x0000_0002;
const FILE_APPEND_DATA = 0x0000_0004;
const FILE_READ_EA = 0x0000_0008;
const FILE_WRITE_EA = 0x0000_0010;
const FILE_DELETE_CHILD = 0x0000_0040;
const FILE_READ_ATTRIBUTES = 0x0000_0080;
const FILE_WRITE_ATTRIBUTES = 0x0000_0100;

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

function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
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

function validateFlags(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const raw = value.raw;
  if (!isUint32(raw) || (raw & ~0xdf) !== 0) return false;
  const fields = [
    ["objectInherit", 0x01], ["containerInherit", 0x02],
    ["noPropagateInherit", 0x04], ["inheritOnly", 0x08], ["inherited", 0x10],
    ["successfulAccess", 0x40], ["failedAccess", 0x80],
  ] as const;
  return fields.every(([field, bit]) =>
    typeof value[field] === "boolean" && value[field] === ((raw & bit) !== 0));
}

function validateAce(value: unknown): value is NativeWindowsAccessControlEntry {
  return isRecord(value) && typeof value.sid === "string" && SID_RE.test(value.sid) &&
    isUint32(value.mask) && (value.aceType === "allow" || value.aceType === "deny") &&
    validateFlags(value.flags);
}

function canRead(mask: number): boolean {
  return (mask & (GENERIC_ALL | GENERIC_READ | FILE_READ_DATA | FILE_READ_EA |
    FILE_READ_ATTRIBUTES)) !== 0;
}

function canWrite(mask: number): boolean {
  return (mask & (GENERIC_ALL | GENERIC_WRITE | FILE_WRITE_DATA | FILE_APPEND_DATA |
    FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | FILE_DELETE_CHILD | DELETE_ACCESS |
    WRITE_DAC | WRITE_OWNER)) !== 0;
}

function expectedOwnerClass(facts: NativeWindowsSecurityFacts): string {
  if (facts.ownerSid === facts.currentUserSid) return "current-user";
  if (facts.ownerSid === SYSTEM_SID) return "system";
  if (facts.ownerSid === ADMINISTRATORS_SID) return "administrators";
  return "foreign";
}

function validateSecurity(value: unknown): NativeWindowsSecurityFacts {
  if (!isRecord(value)) permissionUnverified("Windows descriptor ACL facts were malformed");
  const facts = value as unknown as NativeWindowsSecurityFacts;
  const booleans = [
    "worldWritable", "groupWritable", "worldReadable", "groupReadable",
    "fallbackRequired", "daclPresent", "isLocal", "aceListComplete",
  ] as const;
  if (!booleans.every((field) => typeof facts[field] === "boolean") ||
      typeof facts.ownerSid !== "string" || !SID_RE.test(facts.ownerSid) ||
      typeof facts.currentUserSid !== "string" || !SID_RE.test(facts.currentUserSid) ||
      typeof facts.ownerClass !== "string" || !OWNER_CLASSES.has(facts.ownerClass) ||
      !Array.isArray(facts.unsupportedAceTypes) ||
      !facts.unsupportedAceTypes.every(isUint32) ||
      !Array.isArray(facts.aces) || !facts.aces.every(validateAce)) {
    permissionUnverified("Windows descriptor ACL facts were malformed");
  }
  if (facts.ownerClass !== expectedOwnerClass(facts)) {
    permissionUnverified("Windows descriptor owner facts were inconsistent");
  }
  if (facts.fallbackRequired || !facts.isLocal || !facts.aceListComplete ||
      facts.unsupportedAceTypes.length !== 0) {
    permissionUnverified("Windows descriptor ACL facts were incomplete or unsupported");
  }
  if (!facts.daclPresent && facts.aces.length !== 0) {
    permissionUnverified("Windows descriptor DACL facts were inconsistent");
  }
  return facts;
}

function validatePermissionSummary(facts: NativeWindowsSecurityFacts): void {
  let worldReadable = !facts.daclPresent;
  let worldWritable = !facts.daclPresent;
  let groupReadable = false;
  let groupWritable = false;
  const trustedSids = new Set([facts.currentUserSid, SYSTEM_SID, ADMINISTRATORS_SID]);
  for (const ace of facts.aces) {
    if (ace.aceType !== "allow" || ace.flags.inheritOnly || trustedSids.has(ace.sid)) continue;
    const world = WORLD_SIDS.has(ace.sid);
    if (world) {
      worldReadable ||= canRead(ace.mask);
      worldWritable ||= canWrite(ace.mask);
    } else {
      groupReadable ||= canRead(ace.mask);
      groupWritable ||= canWrite(ace.mask);
    }
  }
  if (facts.worldReadable !== worldReadable || facts.worldWritable !== worldWritable ||
      facts.groupReadable !== groupReadable || facts.groupWritable !== groupWritable) {
    permissionUnverified("Windows descriptor ACL summary was inconsistent");
  }
}

export function inspectSecureWindowsDescriptor(params: {
  fd: number;
  identity: ExactIdentity;
  stat: Stats;
}): PermissionCheck {
  let native;
  try {
    native = getNativeBinding();
  } catch (cause) {
    permissionUnverified("Windows descriptor ACL verification requires the matching native helper", cause);
  }
  const inspect = native?.inspectWindowsSecureFileHandle;
  if (typeof inspect !== "function") {
    permissionUnverified("Windows descriptor ACL verification requires an up-to-date native helper");
  }
  let result: unknown;
  try {
    result = inspect.call(native, params.fd);
  } catch (cause) {
    permissionUnverified("Windows descriptor ACL verification failed", cause);
  }
  return inspectDescriptorResult(params, result, "native");
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
  const facts = validateSecurity(result.security);
  validatePermissionSummary(facts);
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
  if (typeof native?.inspectWindowsSecureFileHandle === "function") {
    return inspectSecureWindowsDescriptor(params);
  }
  warnNativeFallback("windows-secure-file", "Windows descriptor ACL inspection uses a slower built-in system command.");
  let result: unknown;
  try { result = await inspectWindowsDescriptorCommand(params.fd); } catch (cause) {
    permissionUnverified("Windows descriptor ACL verification failed", cause);
  }
  return inspectDescriptorResult(params, result, "system-command");
}
