import { describe, expect, it } from "vitest";
import { parseWindowsSecurityCommandFacts, validateSecureWindowsSecurityFacts } from "../src/windows-security-facts.js";
import { inspectWindowsAcl } from "../src/permissions-windows.js";

const user = "s-1-5-21-1-2-3-1001";
const own = "s-1-15-2-1-2-3-4-5-6-7";
const other = "s-1-15-2-8-9-10-11-12-13-14";
function facts(currentAppContainerSid: string | null, granted: string) {
  return {
    ownerSid: user, currentUserSid: user, currentAppContainerSid,
    daclPresent: true, daclProtected: true, isLocal: true, aceListComplete: true, unsupportedAceTypes: [],
    aces: [user, "s-1-5-18", "s-1-5-32-544", granted].map(sid => ({
      sid, mask: 0x1f01ff, aceType: "allow", flags: {
        raw: 3, objectInherit: true, containerInherit: true, noPropagateInherit: false,
        inheritOnly: false, inherited: false, successfulAccess: false, failedAccess: false,
      },
    })),
  };
}

describe("AppContainer descriptor policy", () => {
  it.each(["s-1-5-18", "s-1-5-32-544", "s-1-5-21-9-8-7-1002"])("keeps command SID trust independent of owner %s", async ownerSid => {
    const value = { ...facts(own, own), ownerSid };
    const nativePolicy = parseWindowsSecurityCommandFacts(value);
    const command = await inspectWindowsAcl("C:\\fixture", { exec: async () => ({
      stdout: JSON.stringify({ ...value, remote: false, complete: true,
        aces: value.aces.map(ace => ({ sid: ace.sid, mask: ace.mask, deny: false, inheritOnly: false })),
      }), stderr: "",
    }) });
    expect(command.ok).toBe(true);
    expect(command.untrustedGroup.some(entry => entry.canRead)).toBe(nativePolicy.groupReadable);
    expect(command.untrustedGroup.some(entry => entry.canWrite)).toBe(nativePolicy.groupWritable);
    expect(command.untrustedGroup).toEqual([]);
    expect(command.trusted.some(entry => entry.sid === own)).toBe(true);
  });
  it("accepts only the inspecting process's own container grant", () => {
    const same = parseWindowsSecurityCommandFacts(facts(own, own));
    expect(same.groupReadable).toBe(false);
    expect(same.groupWritable).toBe(false);
    expect(validateSecureWindowsSecurityFacts(same)).toBe(same);
    for (const observer of [other, null]) {
      const foreign = parseWindowsSecurityCommandFacts(facts(observer, own));
      expect(foreign.groupReadable).toBe(true);
      expect(foreign.groupWritable).toBe(true);
    }
  });
  it("never trusts all application packages or a different container", () => {
    for (const sid of [other, "s-1-15-2-1", "s-1-15-2-2"]) {
      const foreign = parseWindowsSecurityCommandFacts(facts(own, sid));
      expect(foreign.groupReadable).toBe(true);
      expect(foreign.groupWritable).toBe(true);
    }
  });
  it("rejects malformed token facts and inconsistent trusted summaries", () => {
    for (const invalid of ["not a SID", "s-1-1-0", "s-1-15-2-1", "s-1-15-2-2"]) {
      expect(() => parseWindowsSecurityCommandFacts(facts(invalid, own))).toThrow();
    }
    const same = parseWindowsSecurityCommandFacts(facts(own, own));
    expect(() => validateSecureWindowsSecurityFacts({ ...same, currentAppContainerSid: other })).toThrow();
  });
});
