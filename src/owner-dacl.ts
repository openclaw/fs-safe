import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
import { getFsSafeNativeConfig } from "./native-config.js";
import { warnNativeFallback } from "./native-fallback-warning.js";
import { assertNoWindowsPathAlias } from "./windows-path-alias.js";
import { readWindowsSecurityFactsCommand } from "./windows-security-command.js";

export type WindowsAceFlags = {
  raw: number;
  objectInherit: boolean;
  containerInherit: boolean;
  noPropagateInherit: boolean;
  inheritOnly: boolean;
  inherited: boolean;
  successfulAccess: boolean;
  failedAccess: boolean;
};

export type WindowsAccessControlEntry = {
  sid: string;
  mask: number;
  aceType: "allow" | "deny";
  flags: WindowsAceFlags;
};

export type OwnerAndDaclResult =
  | {
      status: "supported";
      ownerSid: string;
      currentUserSid: string;
      daclPresent: boolean;
      isLocal: boolean;
      complete: boolean;
      unsupportedAceTypes: number[];
      aces: WindowsAccessControlEntry[];
    }
  | {
      status: "unsupported-platform";
      platform: NodeJS.Platform;
    };

export function readOwnerAndDacl(targetPath: string): OwnerAndDaclResult {
  if (process.platform !== "win32") {
    return { status: "unsupported-platform", platform: process.platform };
  }

  assertNoWindowsPathAlias(
    targetPath,
    "filesystem",
    "owner and DACL path uses a Windows filesystem namespace alias",
  );

  const native = getNativeBinding();
  const inspect = native?.readOwnerAndDacl;
  if (typeof inspect !== "function") {
    if (getFsSafeNativeConfig().mode === "require") {
      throw new FsSafeError("helper-unavailable", "Windows owner and DACL facts require an up-to-date native helper");
    }
    warnNativeFallback("windows-owner-dacl", "Windows owner and DACL inspection uses a slower built-in system command.");
  }
  const facts = typeof inspect === "function" ? inspect.call(native, targetPath) : readWindowsSecurityFactsCommand(targetPath);
  return {
    status: "supported",
    ownerSid: facts.ownerSid,
    currentUserSid: facts.currentUserSid,
    daclPresent: facts.daclPresent,
    isLocal: facts.isLocal,
    complete: facts.aceListComplete,
    unsupportedAceTypes: [...facts.unsupportedAceTypes],
    aces: facts.aces.map((entry) => ({
      sid: entry.sid,
      mask: entry.mask,
      aceType: entry.aceType as "allow" | "deny",
      flags: { ...entry.flags },
    })),
  };
}
