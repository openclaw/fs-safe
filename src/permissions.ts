import fs from "node:fs/promises";
import {
  formatIcaclsResetCommand,
  inspectWindowsPermissions,
  type PermissionExec,
} from "./permissions-windows.js";
export {
  createIcaclsResetCommand,
  formatIcaclsResetCommand,
  formatWindowsAclSummary,
  inspectWindowsAcl,
  parseIcaclsOutput,
  resolveWindowsUserPrincipal,
  summarizeWindowsAcl,
} from "./permissions-windows.js";
export type {
  IcaclsResetCommandOptions,
  PermissionExec,
  WindowsAclEntry,
  WindowsAclSummary,
  WindowsUserInfoProvider,
} from "./permissions-windows.js";

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
    return await inspectWindowsPermissions({
      targetPath,
      stat: st,
      effectiveIsDir,
      effectiveMode,
      bits,
      opts,
    });
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
