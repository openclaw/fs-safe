import { FsSafeError } from "./errors.js";
import type { NativeWindowsAccessControlEntry, NativeWindowsSecurityFacts } from "./native-binding.js";

const SID_RE = /^s-\d+-\d+(?:-\d+)+$/;
const SYSTEM_SID = "s-1-5-18";
const ADMINISTRATORS_SID = "s-1-5-32-544";
const WORLD_SIDS = new Set([
  "s-1-1-0", "s-1-5-11", "s-1-5-32-545", "s-1-5-7",
  "s-1-5-32-546", "s-1-5-4", "s-1-5-2",
]);

type DescriptorFacts = Pick<NativeWindowsSecurityFacts,
  "ownerSid" | "currentUserSid" | "daclPresent" | "isLocal" |
  "aceListComplete" | "unsupportedAceTypes" | "aces">;

export function unverified(message: string, cause?: unknown): never {
  throw new FsSafeError("permission-unverified", message, cause === undefined ? {} : { cause });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function validateAce(value: unknown, allowUnknownFlags: boolean): value is NativeWindowsAccessControlEntry {
  if (!record(value) || typeof value.sid !== "string" || !SID_RE.test(value.sid) ||
      !uint32(value.mask) || (value.aceType !== "allow" && value.aceType !== "deny") ||
      !record(value.flags)) return false;
  const { raw } = value.flags;
  if (!uint32(raw) || (raw & ~(allowUnknownFlags ? 0xff : 0xdf)) !== 0) return false;
  const fields = [
    ["objectInherit", 0x01], ["containerInherit", 0x02],
    ["noPropagateInherit", 0x04], ["inheritOnly", 0x08], ["inherited", 0x10],
    ["successfulAccess", 0x40], ["failedAccess", 0x80],
  ] as const;
  const flags = value.flags;
  return fields.every(([field, bit]) =>
    typeof flags[field] === "boolean" && flags[field] === ((raw & bit) !== 0));
}

function validateDescriptor(value: unknown, allowUnknownFlags: boolean): DescriptorFacts {
  if (!record(value) || typeof value.ownerSid !== "string" || !SID_RE.test(value.ownerSid) ||
      typeof value.currentUserSid !== "string" || !SID_RE.test(value.currentUserSid) ||
      typeof value.daclPresent !== "boolean" || typeof value.isLocal !== "boolean" ||
      typeof value.aceListComplete !== "boolean" || !Array.isArray(value.unsupportedAceTypes) ||
      !value.unsupportedAceTypes.every(uint32) || !Array.isArray(value.aces) ||
      !value.aces.every(ace => validateAce(ace, allowUnknownFlags))) {
    unverified("Windows descriptor ACL facts were malformed");
  }
  if ((!value.daclPresent && value.aces.length !== 0) ||
      (value.aceListComplete && value.unsupportedAceTypes.length !== 0)) {
    unverified("Windows descriptor DACL facts were inconsistent");
  }
  return value as DescriptorFacts;
}

function summarize(facts: DescriptorFacts) {
  const ownerClass = facts.ownerSid === facts.currentUserSid ? "current-user"
    : facts.ownerSid === SYSTEM_SID ? "system"
    : facts.ownerSid === ADMINISTRATORS_SID ? "administrators" : "foreign";
  let worldReadable = !facts.daclPresent;
  let worldWritable = !facts.daclPresent;
  let groupReadable = false;
  let groupWritable = false;
  const trusted = new Set([facts.currentUserSid, SYSTEM_SID, ADMINISTRATORS_SID]);
  for (const ace of facts.aces) {
    if (ace.aceType !== "allow" || ace.flags.inheritOnly || trusted.has(ace.sid)) continue;
    // Generic and file-specific read/write, delete, and security-control rights.
    const canRead = (ace.mask & 0x9000_0089) !== 0;
    const canWrite = (ace.mask & 0x500d_0156) !== 0;
    if (WORLD_SIDS.has(ace.sid)) {
      worldReadable ||= canRead;
      worldWritable ||= canWrite;
    } else {
      groupReadable ||= canRead;
      groupWritable ||= canWrite;
    }
  }
  return { ownerClass, worldReadable, worldWritable, groupReadable, groupWritable };
}

/** Raw reporting retains unknown flag bits; secure admission validates them below. */
export function parseWindowsSecurityCommandFacts(value: unknown): NativeWindowsSecurityFacts {
  const facts = validateDescriptor(value, true);
  if (!record(value) || typeof value.daclProtected !== "boolean") {
    unverified("Windows security command returned malformed descriptor facts");
  }
  return {
    ...facts,
    ...summarize(facts),
    fallbackRequired: !facts.isLocal || !facts.aceListComplete,
  };
}

/** Native and command observations share the same fail-closed admission policy. */
export function validateSecureWindowsSecurityFacts(value: unknown): NativeWindowsSecurityFacts {
  const descriptor = validateDescriptor(value, false);
  const facts = value as NativeWindowsSecurityFacts;
  const summary = summarize(descriptor);
  const booleans = ["worldWritable", "groupWritable", "worldReadable", "groupReadable", "fallbackRequired"] as const;
  if (!booleans.every(field => typeof facts[field] === "boolean") ||
      typeof facts.ownerClass !== "string") {
    unverified("Windows descriptor ACL facts were malformed");
  }
  if (facts.ownerClass !== summary.ownerClass) {
    unverified("Windows descriptor owner facts were inconsistent");
  }
  if (facts.fallbackRequired || !facts.isLocal || !facts.aceListComplete || facts.unsupportedAceTypes.length !== 0) {
    unverified("Windows descriptor ACL facts were incomplete or unsupported");
  }
  if (facts.worldReadable !== summary.worldReadable || facts.worldWritable !== summary.worldWritable ||
      facts.groupReadable !== summary.groupReadable || facts.groupWritable !== summary.groupWritable) {
    unverified("Windows descriptor ACL summary was inconsistent");
  }
  return facts;
}
