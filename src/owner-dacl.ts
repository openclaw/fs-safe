import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";

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

  const native = getNativeBinding();
  if (!native) {
    throw new FsSafeError(
      "helper-unavailable",
      "Windows owner and DACL facts require the bundled native binding",
    );
  }
  const facts = native.readOwnerAndDacl(targetPath);
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
