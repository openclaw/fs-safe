import {
  formatPermissionErrorDetail,
  getPermissionCommandFailure,
  type PermissionCommandFailure,
} from "./permission-exec.js";
import { resolveWindowsSystemCommand } from "./windows-command.js";

export type WindowsOwnerExec = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type WindowsOwnerSummary = {
  sid?: string;
  currentUserSid?: string;
  daclPresent?: boolean;
  aces?: WindowsOwnerAce[];
  aclError?: string;
  remote?: boolean;
  trusted?: boolean;
  error?: string;
  errorDetail?: PermissionCommandFailure;
  errorCause?: unknown;
};

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

function encodePowerShellCommand(source: string): string {
  return Buffer.from(source, "utf16le").toString("base64");
}

function windowsOwnerQueryCommand(targetPath: string): string {
  const encodedPath = Buffer.from(targetPath, "utf8").toString("base64");
  return [
    "$ErrorActionPreference='Stop'",
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$sections=[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner",
    "$acl=if([IO.Directory]::Exists($p)){[IO.Directory]::GetAccessControl($p,$sections)}else{[IO.File]::GetAccessControl($p,$sections)}",
    "$ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "$currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$root=[IO.Path]::GetPathRoot($p)",
    "$extendedDrive=$p.Length -ge 7 -and $p.StartsWith('\\\\?\\') -and [char]::IsLetter($p[4]) -and $p[5] -eq ':' -and $p[6] -eq '\\'",
    "$driveRoot=if($extendedDrive){$p.Substring(4,3)}else{$root}",
    "$namespacePath=$p.StartsWith('\\\\')",
    "$remote=($namespacePath -and -not $extendedDrive) -or ([IO.DriveInfo]::new($driveRoot).DriveType -eq [IO.DriveType]::Network)",
    // Emit only ASCII SID and numeric facts: console encodings can replace both
    // Unicode pathnames and account names before JavaScript receives the bytes.
    "$raw=[System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)",
    "$dacl=$raw.DiscretionaryAcl;$complete=$true",
    "$aces=@(foreach($ace in $dacl){if($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback -or [int]$ace.AceType -notin @(0,1)){$complete=$false;continue};@{sid=$ace.SecurityIdentifier.Value;mask=([long]$ace.AccessMask -band 4294967295);deny=([int]$ace.AceType -eq 1);inheritOnly=([int]$ace.AceFlags -band 8) -ne 0}})",
    "@{ownerSid=$ownerSid;currentUserSid=$currentSid;daclPresent=($null -ne $dacl);aces=$aces;complete=$complete;remote=$remote}|ConvertTo-Json -Depth 4 -Compress",
  ].join(";");
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
  let command = "";
  let startedAt = performance.now();
  try {
    command = resolveWindowsSystemCommand(
      String.raw`WindowsPowerShell\v1.0\powershell.exe`,
      params.env,
    );
    startedAt = performance.now();
    const { stdout } = await params.exec(command, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodePowerShellCommand(windowsOwnerQueryCommand(params.targetPath)),
    ]);
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
    const remote = parsed.remote === true;
    return {
      sid: ownerSid,
      currentUserSid,
      ...parseWindowsAclFacts(parsed),
      remote,
      trusted: !remote && (ownerSid === currentUserSid || TRUSTED_OWNER_SIDS.has(ownerSid)),
    };
  } catch (err) {
    return {
      error: formatPermissionErrorDetail(String(err)),
      errorDetail: getPermissionCommandFailure(err, command, performance.now() - startedAt),
      errorCause: err,
    };
  }
}
