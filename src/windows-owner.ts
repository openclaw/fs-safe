import {
  formatCaughtPermissionFailure,
  getPermissionCommandFailure,
  type PermissionFailureFields,
} from "./permission-exec.js";
import { windowsSecurityHelperPath } from "./windows-security-helper.js";
import { hasWindowsPathAlias } from "./windows-path-alias.js";

export type WindowsOwnerExec = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type WindowsOwnerSummary = Omit<PermissionFailureFields & {
  sid?: string;
  currentUserSid?: string;
  daclPresent?: boolean;
  aces?: WindowsOwnerAce[];
  aclError?: string;
  trusted?: boolean;
}, never>;

export type WindowsOwnerAce = {
  sid: string;
  mask: number;
  deny: boolean;
  inheritOnly: boolean;
};

const SID_RE = /^\*?s-\d+-\d+(-\d+)+$/i;
const TRUSTED_OWNER_SIDS = new Set(["s-1-5-18", "s-1-5-32-544"]);

function normalizeSid(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("*") ? normalized.slice(1) : normalized;
}

function parseWindowsAclFacts(parsed: Record<string, unknown>): Pick<WindowsOwnerSummary, "daclPresent" | "aces" | "aclError"> {
  if (parsed.complete !== true || typeof parsed.daclPresent !== "boolean" || !Array.isArray(parsed.aces)) {
    return { aclError: "Windows ACL query returned incomplete descriptor data" };
  }
  const aces: WindowsOwnerAce[] = [];
  for (const row of parsed.aces) {
    if (!row || typeof row !== "object" || typeof row.sid !== "string" || !SID_RE.test(row.sid) ||
        typeof row.mask !== "number" || !Number.isInteger(row.mask) || row.mask < 0 || row.mask > 0xffff_ffff ||
        typeof row.deny !== "boolean" || typeof row.inheritOnly !== "boolean") {
      return { aclError: "Windows ACL query returned invalid access-rule data" };
    }
    aces.push({ sid: normalizeSid(row.sid), mask: row.mask, deny: row.deny, inheritOnly: row.inheritOnly });
  }
  return { daclPresent: parsed.daclPresent, aces };
}

export async function inspectWindowsOwner(params: {
  targetPath: string;
  env?: NodeJS.ProcessEnv;
  exec: WindowsOwnerExec;
}): Promise<WindowsOwnerSummary> {
  if (hasWindowsPathAlias(params.targetPath, "filesystem", "win32")) {
    const error = new Error("Path uses a Windows filesystem namespace alias");
    return { error: String(error), errorCause: error };
  }
  let command = "";
  let startedAt = performance.now();
  try {
    command = windowsSecurityHelperPath();
    startedAt = performance.now();
    const { stdout } = await params.exec(command, ["owner", params.targetPath]);
    const value: unknown = JSON.parse(stdout.trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "Windows owner query returned invalid SID data" };
    }
    const parsed = value as Record<string, unknown>;
    const ownerSid =
      typeof parsed.ownerSid === "string" && SID_RE.test(parsed.ownerSid)
        ? normalizeSid(parsed.ownerSid)
        : undefined;
    const currentUserSid =
      typeof parsed.currentUserSid === "string" && SID_RE.test(parsed.currentUserSid)
        ? normalizeSid(parsed.currentUserSid)
        : undefined;
    if (!ownerSid || !currentUserSid) {
      return { error: "Windows owner query returned invalid SID data" };
    }
    const remote = parsed.remote;
    if (typeof remote !== "boolean") {
      return { error: "Windows owner query returned invalid locality data" };
    }
    return {
      sid: ownerSid,
      currentUserSid,
      ...parseWindowsAclFacts(parsed),
      trusted: !remote && (ownerSid === currentUserSid || TRUSTED_OWNER_SIDS.has(ownerSid)),
    };
  } catch (err) {
    return {
      error: formatCaughtPermissionFailure(err),
      errorDetail: getPermissionCommandFailure(err, command, performance.now() - startedAt),
      errorCause: err,
    };
  }
}
