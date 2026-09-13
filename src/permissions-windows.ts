import os from "node:os";
import { getNativeBinding } from "./native.js";
import { executePermissionCommand, type PermissionCommandFailure } from "./permission-exec.js";
import type { PermissionCheck, PermissionCheckOptions, SafeStatResult } from "./permissions.js";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";
import { resolveWindowsSystemCommand } from "./windows-command.js";
import { inspectWindowsOwner, type WindowsOwnerSummary } from "./windows-owner.js";

export type PermissionExec = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type WindowsAclEntry = {
  principal: string;
  /** Canonical principal SID when resolved from Windows. */
  sid?: string;
  rights: string[];
  rawRights: string;
  canRead: boolean;
  canWrite: boolean;
};

export type WindowsAclSummary = {
  ok: boolean;
  entries: WindowsAclEntry[];
  untrustedWorld: WindowsAclEntry[];
  untrustedGroup: WindowsAclEntry[];
  trusted: WindowsAclEntry[];
  error?: string;
  errorDetail?: PermissionCommandFailure;
  errorCause?: unknown;
};

export type WindowsUserInfoProvider = () => { username?: string | null };

export type IcaclsResetCommandOptions = {
  isDir: boolean;
  env?: NodeJS.ProcessEnv;
  userInfo?: WindowsUserInfoProvider;
};

const INHERIT_FLAGS = new Set(["I", "OI", "CI", "IO", "NP"]);
const WORLD_PRINCIPALS = new Set(["everyone", "users", "builtin\\users", "authenticated users", "nt authority\\authenticated users", "anonymous logon", "nt authority\\anonymous logon", "guests", "builtin\\guests", "interactive", "nt authority\\interactive", "network", "nt authority\\network", "local"]);
const TRUSTED_BASE = new Set([
  "nt authority\\system",
  "system",
  "builtin\\administrators",
  "creator owner",
  "autorite nt\\système",
  "nt-autorität\\system",
  "autoridad nt\\system",
  "autoridade nt\\system",
]);
const WORLD_SUFFIXES = ["\\users", "\\authenticated users"];
const SID_RE = /^\*?s-\d+-\d+(-\d+)+$/i;
const TRUSTED_SIDS = new Set([
  "s-1-5-18",
  "s-1-5-32-544",
  "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
const WORLD_SIDS = new Set(["s-1-1-0", "s-1-5-11", "s-1-5-32-545", "s-1-5-7", "s-1-5-32-546", "s-1-5-4", "s-1-2-0", "s-1-5-2"]);
const STATUS_PREFIXES = [
  "successfully processed",
  "processed",
  "failed processing",
  "no mapping between account names",
];

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const TRUSTED_BASE_ASCII = new Set([...TRUSTED_BASE].map(stripDiacritics));
const normalize = (value: string) => normalizeLowercaseStringOrEmpty(value);
const defaultWindowsUserInfo: WindowsUserInfoProvider = () => os.userInfo();
const defaultPermissionExec: PermissionExec = executePermissionCommand;

function inspectWindowsPermissionsNative(params: {
  targetPath: string;
  stat: SafeStatResult;
  effectiveIsDir: boolean;
  effectiveMode: number | null;
  bits: number | null;
}): PermissionCheck | undefined {
  const native = getNativeBinding();
  if (!native) return undefined;
  try {
    const facts = native.readOwnerAndDacl(params.targetPath);
    if (facts.fallbackRequired) return undefined;
    return {
      ok: true,
      isSymlink: params.stat.isSymlink,
      isDir: params.effectiveIsDir,
      mode: params.effectiveMode,
      bits: params.bits,
      source: "windows-acl",
      worldWritable: facts.worldWritable,
      groupWritable: facts.groupWritable,
      worldReadable: facts.worldReadable,
      groupReadable: facts.groupReadable,
      ownerSid: facts.ownerSid,
      ownerTrusted: facts.ownerClass !== "foreign",
      aclSummary:
        `native owner=${facts.ownerClass} world=` +
        `${facts.worldReadable ? "r" : "-"}${facts.worldWritable ? "w" : "-"} ` +
        `group=${facts.groupReadable ? "r" : "-"}${facts.groupWritable ? "w" : "-"}`,
    };
  } catch {
    return undefined;
  }
}

export async function inspectWindowsPermissions(params: {
  targetPath: string;
  stat: SafeStatResult;
  effectiveIsDir: boolean;
  effectiveMode: number | null;
  bits: number | null;
  opts?: PermissionCheckOptions;
}): Promise<PermissionCheck> {
  const native = inspectWindowsPermissionsNative(params);
  if (native) return native;
  const unverified: PermissionCheck = {
    ok: true,
    isSymlink: params.stat.isSymlink,
    isDir: params.effectiveIsDir,
    mode: params.effectiveMode,
    bits: params.bits,
    source: "unknown",
    worldWritable: false,
    groupWritable: false,
    worldReadable: false,
    groupReadable: false,
  };
  const owner = await inspectWindowsOwner({
    targetPath: params.targetPath,
    env: params.opts?.env,
    exec: params.opts?.exec ?? defaultPermissionExec,
  });
  if (owner.error) {
    const error = `Windows owner inspection failed: ${owner.error}`;
    return { ...unverified, ownerError: owner.error, error, errorDetail: owner.errorDetail, errorCause: owner.errorCause };
  }
  const acl = summarizeWindowsOwnerAcl(owner);
  const ownerFields = {
    ...(owner.sid ? { ownerSid: owner.sid } : {}),
    ...(owner.trusted !== undefined ? { ownerTrusted: owner.trusted } : {}),
    ...(owner.error ? { ownerError: owner.error } : {}),
  };
  if (!acl.ok) return { ...unverified, ...ownerFields, error: acl.error, errorDetail: acl.errorDetail, errorCause: acl.errorCause };
  return {
    ok: true,
    isSymlink: params.stat.isSymlink,
    isDir: params.effectiveIsDir,
    mode: params.effectiveMode,
    bits: params.bits,
    source: "windows-acl",
    worldWritable: acl.untrustedWorld.some((entry) => entry.canWrite),
    groupWritable: acl.untrustedGroup.some((entry) => entry.canWrite),
    worldReadable: acl.untrustedWorld.some((entry) => entry.canRead),
    groupReadable: acl.untrustedGroup.some((entry) => entry.canRead),
    ...ownerFields,
    aclSummary: formatWindowsAclSummary(acl),
  };
}

function normalizeSid(value: string): string {
  const normalized = normalize(value);
  return normalized.startsWith("*") ? normalized.slice(1) : normalized;
}

export function resolveWindowsUserPrincipal(
  env?: NodeJS.ProcessEnv,
  userInfo: WindowsUserInfoProvider = defaultWindowsUserInfo,
): string | null {
  const username = env?.USERNAME?.trim() || userInfo().username?.trim();
  if (!username) return null;
  const domain = env?.USERDOMAIN?.trim();
  return domain ? `${domain}\\${username}` : username;
}

function buildTrustedPrincipals(env?: NodeJS.ProcessEnv): Set<string> {
  const trusted = new Set<string>(TRUSTED_BASE);
  const principal = resolveWindowsUserPrincipal(env);
  if (principal) {
    trusted.add(normalize(principal));
    const userOnly = principal.split("\\").at(-1);
    if (userOnly) trusted.add(normalize(userOnly));
  }
  const userSid = normalizeSid(env?.USERSID ?? "");
  if (userSid && SID_RE.test(userSid) && !WORLD_SIDS.has(userSid)) trusted.add(userSid);
  return trusted;
}

function classifyPrincipal(principal: string, trustedPrincipals: Set<string>): "trusted" | "world" | "group" {
  const normalized = normalize(principal);
  if (SID_RE.test(normalized)) {
    const sid = normalizeSid(normalized);
    if (WORLD_SIDS.has(sid)) return "world";
    if (TRUSTED_SIDS.has(sid) || trustedPrincipals.has(sid)) return "trusted";
    return "group";
  }
  if (trustedPrincipals.has(normalized) || TRUSTED_BASE.has(normalized)) return "trusted";
  if (WORLD_PRINCIPALS.has(normalized) || WORLD_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return "world";
  const stripped = stripDiacritics(normalized);
  return stripped !== normalized && TRUSTED_BASE_ASCII.has(stripped) ? "trusted" : "group";
}

function rightsFromTokens(tokens: string[]): { canRead: boolean; canWrite: boolean } {
  const upper = tokens.join("").toUpperCase();
  return {
    canWrite: upper.includes("F") || upper.includes("M") || upper.includes("W") || upper.includes("D"),
    canRead: upper.includes("F") || upper.includes("M") || upper.includes("R"),
  };
}

function stripTargetPrefix(params: { trimmedLine: string; lowerLine: string; normalizedTarget: string; lowerTarget: string; quotedTarget: string; quotedLower: string }): string {
  if (params.lowerLine.startsWith(params.lowerTarget)) return params.trimmedLine.slice(params.normalizedTarget.length).trim();
  if (params.lowerLine.startsWith(params.quotedLower)) return params.trimmedLine.slice(params.quotedTarget.length).trim();
  return params.trimmedLine;
}

function parseAceEntry(entry: string): WindowsAclEntry | null {
  if (!entry.includes("(")) return null;
  const idx = entry.indexOf(":");
  if (idx === -1) return null;
  const principal = entry.slice(0, idx).trim();
  const rawRights = entry.slice(idx + 1).trim();
  const tokens = rawRights.match(/\(([^)]+)\)/g)?.map((token) => token.slice(1, -1).trim()).filter(Boolean) ?? [];
  if (tokens.some((token) => token.toUpperCase() === "DENY")) return null;
  const rights = tokens.filter((token) => !INHERIT_FLAGS.has(token.toUpperCase()));
  if (rights.length === 0) return null;
  const normalizedPrincipal = normalizeSid(principal);
  return { principal, ...(SID_RE.test(normalizedPrincipal) ? { sid: normalizedPrincipal } : {}), rights, rawRights, ...rightsFromTokens(rights) };
}

export function parseIcaclsOutput(output: string, targetPath: string): WindowsAclEntry[] {
  const entries: WindowsAclEntry[] = [];
  const normalizedTarget = targetPath.trim();
  const lowerTarget = normalizedTarget.toLowerCase();
  const quotedTarget = `"${normalizedTarget}"`;
  const quotedLower = quotedTarget.toLowerCase();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const trimmed = line.trim();
    const lowerLine = trimmed.toLowerCase();
    if (STATUS_PREFIXES.some((prefix) => lowerLine.startsWith(prefix))) continue;
    const parsed = parseAceEntry(stripTargetPrefix({ trimmedLine: trimmed, lowerLine, normalizedTarget, lowerTarget, quotedTarget, quotedLower }));
    if (parsed) entries.push(parsed);
  }
  return entries;
}

export function summarizeWindowsAcl(entries: WindowsAclEntry[], env?: NodeJS.ProcessEnv): Pick<WindowsAclSummary, "trusted" | "untrustedWorld" | "untrustedGroup"> {
  const trustedPrincipals = buildTrustedPrincipals(env);
  const trusted: WindowsAclEntry[] = [];
  const untrustedWorld: WindowsAclEntry[] = [];
  const untrustedGroup: WindowsAclEntry[] = [];
  for (const entry of entries) {
    const classification = classifyPrincipal(entry.sid ?? entry.principal, trustedPrincipals);
    if (classification === "trusted") trusted.push(entry);
    else if (classification === "world") untrustedWorld.push(entry);
    else untrustedGroup.push(entry);
  }
  return { trusted, untrustedWorld, untrustedGroup };
}

const MASK_RIGHTS: ReadonlyArray<readonly [number, string]> = [
  [0x1000_0000, "GA"], [0x8000_0000, "GR"], [0x4000_0000, "GW"], [0x2000_0000, "GE"],
  [0x0001_0000, "D"], [0x0002_0000, "RC"], [0x0004_0000, "WDAC"], [0x0008_0000, "WO"],
  [0x0010_0000, "S"], [0x0001, "RD"], [0x0002, "WD"], [0x0004, "AD"],
  [0x0008, "REA"], [0x0010, "WEA"], [0x0020, "X"], [0x0040, "DC"], [0x0080, "RA"], [0x0100, "WA"],
];

function summarizeWindowsOwnerAcl(owner: WindowsOwnerSummary): WindowsAclSummary {
  const error = owner.error ?? owner.aclError;
  if (error || owner.daclPresent === undefined || !owner.aces || !owner.currentUserSid) {
    return {
      ok: false, entries: [], trusted: [], untrustedWorld: [], untrustedGroup: [],
      error: error ?? "Windows ACL query returned incomplete descriptor data",
      errorDetail: owner.errorDetail, errorCause: owner.errorCause,
    };
  }
  // A null DACL grants everyone full access; an empty DACL grants nothing.
  const grants = owner.daclPresent ? owner.aces : [{ sid: "s-1-1-0", mask: 0x001f_01ff, deny: false, inheritOnly: false }];
  const entries: WindowsAclEntry[] = grants.filter(ace => !ace.deny && !ace.inheritOnly).map(ace => {
    const rights = ace.mask === 0x001f_01ff ? ["F"] : MASK_RIGHTS.filter(([mask]) => (ace.mask & mask) !== 0).map(([, name]) => name);
    return {
      principal: ace.sid, sid: ace.sid, rights, rawRights: "(" + rights.join(",") + ")",
      // Retain the coarse policy's conservative treatment of read-control and
      // mutation rights. Denies do not subtract grants or claim effective access.
      canRead: (ace.mask & 0x9002_0089) !== 0,
      canWrite: (ace.mask & 0x500d_0156) !== 0,
    };
  });
  return { ok: true, entries, ...summarizeWindowsAcl(entries, { USERSID: owner.currentUserSid }) };
}

export async function inspectWindowsAcl(targetPath: string, opts?: { env?: NodeJS.ProcessEnv; exec?: PermissionExec; currentUserSid?: string; principalSids?: Record<string, string>; principalTranslationFailed?: boolean }): Promise<WindowsAclSummary> {
  if (opts?.principalTranslationFailed) {
    const error = new Error("Windows ACL principal SID translation failed");
    return summarizeWindowsOwnerAcl({ error: String(error), errorCause: error });
  }
  const owner = await inspectWindowsOwner({ targetPath, env: opts?.env, exec: opts?.exec ?? defaultPermissionExec });
  return summarizeWindowsOwnerAcl({
    ...owner,
    currentUserSid: normalizeSid(opts?.currentUserSid ?? "") || owner.currentUserSid,
  });
}

export function formatWindowsAclSummary(summary: WindowsAclSummary): string {
  if (!summary.ok) return "unknown";
  const untrusted = [...summary.untrustedWorld, ...summary.untrustedGroup];
  return untrusted.length === 0 ? "trusted-only" : untrusted.map((entry) => `${entry.principal}:${entry.rawRights}`).join(", ");
}

export function formatIcaclsResetCommand(targetPath: string, opts: IcaclsResetCommandOptions): string {
  const command = resolveWindowsSystemCommand("icacls.exe", opts.env);
  const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo) ?? "%USERNAME%";
  const grant = opts.isDir ? "(OI)(CI)F" : "F";
  return [command, `"${targetPath}"`, "/inheritance:r", "/grant:r", `"${user}:${grant}"`, "/grant:r", `"*S-1-5-18:${grant}"`].join(" ");
}

export function createIcaclsResetCommand(targetPath: string, opts: IcaclsResetCommandOptions): { command: string; args: string[]; display: string } | null {
  const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo);
  if (!user) return null;
  const grant = opts.isDir ? "(OI)(CI)F" : "F";
  const args = [targetPath, "/inheritance:r", "/grant:r", `${user}:${grant}`, "/grant:r", `*S-1-5-18:${grant}`];
  return { command: resolveWindowsSystemCommand("icacls.exe", opts.env), args, display: formatIcaclsResetCommand(targetPath, opts) };
}
