import { expect, it } from "vitest";
import { projectOwnerAndDacl } from "../src/owner-dacl.js";
import { parseWindowsOwnerAndDaclFacts, validateSecureWindowsSecurityFacts } from "../src/windows-security-facts.js";

function facts(mask = 0x001200a9, extra: Record<string, unknown> = {}) {
  return {
    ownerSid: "s-1-5-21-42", currentUserSid: "s-1-5-21-42",
    ownerClass: "current-user", daclPresent: true, isLocal: true,
    aceListComplete: true, unsupportedAceTypes: [], fallbackRequired: false,
    worldReadable: false, worldWritable: false, groupReadable: false, groupWritable: false,
    aces: [{
      sid: "s-1-5-21-42", mask, aceType: "allow", isCallback: true,
      flags: {
        raw: 0, objectInherit: false, containerInherit: false, noPropagateInherit: false,
        inheritOnly: false, inherited: false, successfulAccess: false, failedAccess: false,
      },
      ...extra,
    }],
  };
}

it("preserves the callback marker across validated transport and public projection", () => {
  const parsed = parseWindowsOwnerAndDaclFacts(facts());
  expect(projectOwnerAndDacl(parsed)).toMatchObject({
    status: "supported", complete: true, aces: [{ isCallback: true }],
  });
});

it.each([2, 4, 0x40, 0x100, 0x10000, 0x40000, 0x80000, 0x10000000,
  0x40000000, 0x02000000, 0x01000000, 0x200])("refuses unsupported callback mask %i in transport", mask => {
  expect(() => parseWindowsOwnerAndDaclFacts(facts(mask))).toThrow(expect.objectContaining({ code: "permission-unverified" }));
});

it.each([{ aceType: "deny" }, { isCallback: "true" }, {
  flags: { raw: 0x20, objectInherit: false, containerInherit: false, noPropagateInherit: false,
    inheritOnly: false, inherited: false, successfulAccess: false, failedAccess: false },
}])("refuses malformed or unsupported callback observations %j", extra => {
  expect(() => parseWindowsOwnerAndDaclFacts(facts(1, extra))).toThrow(expect.objectContaining({ code: "permission-unverified" }));
});

it("rejects even a trusted-principal callback for secure descriptor admission", () => {
  expect(() => validateSecureWindowsSecurityFacts(facts())).toThrow(expect.objectContaining({ code: "permission-unverified" }));
  const basic = facts(1, { isCallback: undefined });
  expect(validateSecureWindowsSecurityFacts(basic)).toMatchObject({ ownerClass: "current-user" });
});
