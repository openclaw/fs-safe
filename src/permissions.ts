import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executePermissionCommand } from "./permission-exec.js";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";
import { inspectWindowsPermissionsNative } from "./windows-permissions-native.js";
import { resolveWindowsSystemCommand } from "./windows-command.js";
import {
  inspectWindowsOwner,
  resolveWindowsCurrentUserSid,
  resolveWindowsPrincipalSids,
} from "./windows-owner.js";
export type PermissionExec = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type PermissionCheck = {
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  bits: number | null;
  source: "posix" | "windows-acl" | "unknown";
  worldWritable: boolean;
  groupWritable: boolean;
  worldReadable: boolean;
  groupReadable: boolean;
  /** Canonical Windows owner SID when the owner query succeeds. */
  ownerSid?: string;
  /** Whether the Windows owner is the current user, LocalSystem, or Administrators. */
  ownerTrusted?: boolean;
  /** Owner-query failure detail when Windows ownership could not be verified. */
  ownerError?: string;
  aclSummary?: string;
  error?: string;
};

export type PermissionCheckOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: PermissionExec;
};

export type SafeStatResult = {
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  error?: string;
};

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

export async function safeStat(targetPath: string): Promise<SafeStatResult> {
  try {
    const lst = await fs.lstat(targetPath);
    return {
      ok: true,
      isSymlink: lst.isSymbolicLink(),
      isDir: lst.isDirectory(),
      mode: typeof lst.mode === "number" ? lst.mode : null,
      uid: typeof lst.uid === "number" ? lst.uid : null,
      gid: typeof lst.gid === "number" ? lst.gid : null,
    };
  } catch (err) {
    return {
      ok: false,
      isSymlink: false,
      isDir: false,
      mode: null,
      uid: null,
      gid: null,
      error: String(err),
    };
  }
}

export async function inspectPathPermissions(
  targetPath: string,
  opts?: PermissionCheckOptions,
): Promise<PermissionCheck> {
  const st = await safeStat(targetPath);
  if (!st.ok) {
    return {
      ok: false,
      isSymlink: false,
      isDir: false,
      mode: null,
      bits: null,
      source: "unknown",
      worldWritable: false,
      groupWritable: false,
      worldReadable: false,
      groupReadable: false,
      error: st.error,
    };
  }

  let effectiveMode = st.mode;
  let effectiveIsDir = st.isDir;
  if (st.isSymlink) {
    try {
      const target = await fs.stat(targetPath);
      effectiveMode = typeof target.mode === "number" ? target.mode : st.mode;
      effectiveIsDir = target.isDirectory();
    } catch {
      // Keep lstat metadata when the symlink target cannot be inspected.
    }
  }

  const bits = modeBits(effectiveMode);
  const platform = opts?.platform ?? process.platform;
  if (platform === "win32") {
    const native = inspectWindowsPermissionsNative({
      targetPath, stat: st, effectiveIsDir, effectiveMode, bits,
    });
    if (native) return native;
    const unverified: PermissionCheck = {
      ok: true,
      isSymlink: st.isSymlink,
      isDir: effectiveIsDir,
      mode: effectiveMode,
      bits,
      source: "unknown",
      worldWritable: false,
      groupWritable: false,
      worldReadable: false,
      groupReadable: false,
    };
    const owner = await inspectWindowsOwner({
      targetPath,
      env: opts?.env,
      exec: opts?.exec ?? defaultPermissionExec,
    });
    if (owner.error) {
      const error = `Windows owner inspection failed: ${owner.error}`;
      return { ...unverified, ownerError: owner.error, error };
    }
    const acl = await inspectWindowsAcl(targetPath, {
      env: opts?.env,
      exec: opts?.exec,
      currentUserSid: owner.currentUserSid,
      principalSids: owner.principalSids,
      principalTranslationFailed: owner.principalTranslationFailed,
    });
    const ownerFields = {
      ...(owner.sid ? { ownerSid: owner.sid } : {}),
      ...(owner.trusted !== undefined ? { ownerTrusted: owner.trusted } : {}),
      ...(owner.error ? { ownerError: owner.error } : {}),
    };
    if (!acl.ok) {
      return {
        ...unverified,
        ...ownerFields,
        error: acl.error,
      };
    }
    return {
      ok: true,
      isSymlink: st.isSymlink,
      isDir: effectiveIsDir,
      mode: effectiveMode,
      bits,
      source: "windows-acl",
      worldWritable: acl.untrustedWorld.some((entry) => entry.canWrite),
      groupWritable: acl.untrustedGroup.some((entry) => entry.canWrite),
      worldReadable: acl.untrustedWorld.some((entry) => entry.canRead),
      groupReadable: acl.untrustedGroup.some((entry) => entry.canRead),
      ...ownerFields,
      aclSummary: formatWindowsAclSummary(acl),
    };
  }

  return {
    ok: true,
    isSymlink: st.isSymlink,
    isDir: effectiveIsDir,
    mode: effectiveMode,
    bits,
    source: "posix",
    worldWritable: isWorldWritable(bits),
    groupWritable: isGroupWritable(bits),
    worldReadable: isWorldReadable(bits),
    groupReadable: isGroupReadable(bits),
  };
}

export function formatPermissionDetail(targetPath: string, perms: PermissionCheck): string {
  if (perms.source === "windows-acl") {
    return `${targetPath} acl=${perms.aclSummary ?? "unknown"}`;
  }
  return `${targetPath} mode=${formatOctal(perms.bits)}`;
}

export function formatPermissionRemediation(params: {
  targetPath: string;
  perms: PermissionCheck;
  isDir: boolean;
  posixMode: number;
  env?: NodeJS.ProcessEnv;
}): string {
  if (params.perms.source === "windows-acl") {
    return formatIcaclsResetCommand(params.targetPath, {
      isDir: params.isDir,
      env: params.env,
    });
  }
  return `chmod ${params.posixMode.toString(8).padStart(3, "0")} ${params.targetPath}`;
}

export function modeBits(mode: number | null): number | null {
  return mode == null ? null : mode & 0o777;
}

export function formatOctal(bits: number | null): string {
  return bits == null ? "unknown" : bits.toString(8).padStart(3, "0");
}

export function isWorldWritable(bits: number | null): boolean {
  return bits != null && (bits & 0o002) !== 0;
}

export function isGroupWritable(bits: number | null): boolean {
  return bits != null && (bits & 0o020) !== 0;
}

export function isWorldReadable(bits: number | null): boolean {
  return bits != null && (bits & 0o004) !== 0;
}

export function isGroupReadable(bits: number | null): boolean {
  return bits != null && (bits & 0o040) !== 0;
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
  if (!username) {
    return null;
  }
  const domain = env?.USERDOMAIN?.trim();
  return domain ? `${domain}\\${username}` : username;
}

function buildTrustedPrincipals(env?: NodeJS.ProcessEnv): Set<string> {
  const trusted = new Set<string>(TRUSTED_BASE);
  const principal = resolveWindowsUserPrincipal(env);
  if (principal) {
    trusted.add(normalize(principal));
    const userOnly = principal.split("\\").at(-1);
    if (userOnly) {
      trusted.add(normalize(userOnly));
    }
  }
  const userSid = normalizeSid(env?.USERSID ?? "");
  if (userSid && SID_RE.test(userSid) && !WORLD_SIDS.has(userSid)) {
    trusted.add(userSid);
  }
  return trusted;
}

function classifyPrincipal(
  principal: string,
  trustedPrincipals: Set<string>,
): "trusted" | "world" | "group" {
  const normalized = normalize(principal);
  if (SID_RE.test(normalized)) {
    const sid = normalizeSid(normalized);
    if (WORLD_SIDS.has(sid)) return "world";
    if (TRUSTED_SIDS.has(sid) || trustedPrincipals.has(sid)) return "trusted";
    return "group";
  }
  if (trustedPrincipals.has(normalized) || TRUSTED_BASE.has(normalized)) {
    return "trusted";
  }
  if (
    WORLD_PRINCIPALS.has(normalized) ||
    WORLD_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    return "world";
  }
  const stripped = stripDiacritics(normalized);
  if (stripped !== normalized && TRUSTED_BASE_ASCII.has(stripped)) {
    return "trusted";
  }
  return "group";
}

function rightsFromTokens(tokens: string[]): { canRead: boolean; canWrite: boolean } {
  const upper = tokens.join("").toUpperCase();
  return {
    canWrite:
      upper.includes("F") || upper.includes("M") || upper.includes("W") || upper.includes("D"),
    canRead: upper.includes("F") || upper.includes("M") || upper.includes("R"),
  };
}

function stripTargetPrefix(params: {
  trimmedLine: string;
  lowerLine: string;
  normalizedTarget: string;
  lowerTarget: string;
  quotedTarget: string;
  quotedLower: string;
}): string {
  if (params.lowerLine.startsWith(params.lowerTarget)) {
    return params.trimmedLine.slice(params.normalizedTarget.length).trim();
  }
  if (params.lowerLine.startsWith(params.quotedLower)) {
    return params.trimmedLine.slice(params.quotedTarget.length).trim();
  }
  return params.trimmedLine;
}

function parseAceEntry(entry: string): WindowsAclEntry | null {
  if (!entry.includes("(")) return null;
  const idx = entry.indexOf(":");
  if (idx === -1) return null;
  const principal = entry.slice(0, idx).trim();
  const rawRights = entry.slice(idx + 1).trim();
  const tokens =
    rawRights
      .match(/\(([^)]+)\)/g)
      ?.map((token) => token.slice(1, -1).trim())
      .filter(Boolean) ?? [];
  if (tokens.some((token) => token.toUpperCase() === "DENY")) return null;
  const rights = tokens.filter((token) => !INHERIT_FLAGS.has(token.toUpperCase()));
  if (rights.length === 0) return null;
  const normalizedPrincipal = normalizeSid(principal);
  return {
    principal,
    ...(SID_RE.test(normalizedPrincipal) ? { sid: normalizedPrincipal } : {}),
    rights,
    rawRights,
    ...rightsFromTokens(rights),
  };
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
    const lower = trimmed.toLowerCase();
    if (STATUS_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    const parsed = parseAceEntry(
      stripTargetPrefix({
        trimmedLine: trimmed,
        lowerLine: lower,
        normalizedTarget,
        lowerTarget,
        quotedTarget,
        quotedLower,
      }),
    );
    if (parsed) entries.push(parsed);
  }
  return entries;
}

export function summarizeWindowsAcl(
  entries: WindowsAclEntry[],
  env?: NodeJS.ProcessEnv,
): Pick<WindowsAclSummary, "trusted" | "untrustedWorld" | "untrustedGroup"> {
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

export async function inspectWindowsAcl(
  targetPath: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    exec?: PermissionExec;
    currentUserSid?: string;
    principalSids?: Record<string, string>;
    principalTranslationFailed?: boolean;
  },
): Promise<WindowsAclSummary> {
  const exec = opts?.exec ?? defaultPermissionExec;
  try {
    if (opts?.principalTranslationFailed) {
      throw new Error("Windows ACL principal SID translation failed");
    }
    const { stdout, stderr } = await exec(resolveWindowsSystemCommand("icacls.exe", opts?.env), [
      targetPath,
    ]);
    let entries = parseIcaclsOutput(`${stdout}\n${stderr}`.trim(), targetPath);
    if (!entries.length) throw new Error("Windows ACL output could not be verified");
    const unresolvedPrincipals = entries
      .filter((entry) => !entry.sid)
      .map((entry) => entry.principal);
    const principalSids = await resolveWindowsPrincipalSids({
      principals: unresolvedPrincipals,
      known: opts?.principalSids,
      env: opts?.env,
      exec,
    });
    entries = entries.map((entry) => {
      const sid = entry.sid ?? principalSids[entry.principal.toLowerCase()];
      if (!sid) {
        throw new Error(`Windows ACL principal SID could not be verified: ${entry.principal}`);
      }
      return { ...entry, sid };
    });
    let currentUserSid = normalizeSid(opts?.currentUserSid ?? "");
    let effectiveEnv = currentUserSid ? { USERSID: currentUserSid } : undefined;
    let { trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, effectiveEnv);
    const needsUserSidResolution =
      !currentUserSid && untrustedGroup.some((entry) => entry.sid && !TRUSTED_SIDS.has(entry.sid));
    if (needsUserSidResolution) {
      currentUserSid =
        (await resolveWindowsCurrentUserSid({ exec, env: opts?.env })) ?? "";
      if (currentUserSid) {
        effectiveEnv = { USERSID: currentUserSid };
        ({ trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, effectiveEnv));
      }
    }
    return { ok: true, entries, trusted, untrustedWorld, untrustedGroup };
  } catch (err) {
    return {
      ok: false,
      entries: [],
      trusted: [],
      untrustedWorld: [],
      untrustedGroup: [],
      error: String(err),
    };
  }
}

export function formatWindowsAclSummary(summary: WindowsAclSummary): string {
  if (!summary.ok) return "unknown";
  const untrusted = [...summary.untrustedWorld, ...summary.untrustedGroup];
  return untrusted.length === 0
    ? "trusted-only"
    : untrusted.map((entry) => `${entry.principal}:${entry.rawRights}`).join(", ");
}

export function formatIcaclsResetCommand(
  targetPath: string,
  opts: IcaclsResetCommandOptions,
): string {
  const command = resolveWindowsSystemCommand("icacls.exe", opts.env);
  const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo) ?? "%USERNAME%";
  const grant = opts.isDir ? "(OI)(CI)F" : "F";
  return [
    command,
    `"${targetPath}"`,
    "/inheritance:r",
    "/grant:r",
    `"${user}:${grant}"`,
    "/grant:r",
    `"*S-1-5-18:${grant}"`,
  ].join(" ");
}

export function createIcaclsResetCommand(
  targetPath: string,
  opts: IcaclsResetCommandOptions,
): { command: string; args: string[]; display: string } | null {
  const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo);
  if (!user) {
    return null;
  }
  const grant = opts.isDir ? "(OI)(CI)F" : "F";
  const args = [
    targetPath,
    "/inheritance:r",
    "/grant:r",
    `${user}:${grant}`,
    "/grant:r",
    `*S-1-5-18:${grant}`,
  ];
  return {
    command: resolveWindowsSystemCommand("icacls.exe", opts.env),
    args,
    display: formatIcaclsResetCommand(targetPath, opts),
  };
}
