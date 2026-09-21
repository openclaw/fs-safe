import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectWindowsAcl } from "../src/advanced.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { inspectPathPermissions } from "../src/permissions-public.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
const currentUserSid = "S-1-5-21-42";
const env = { SystemRoot: "C:\\Windows" };
const invalidLocality = "Windows owner query returned invalid locality data";

function ownerQuery(remote: unknown, ownerSid = currentUserSid) {
  return vi.fn(async () => ({
    stdout: JSON.stringify({
      ownerSid, currentUserSid, remote, complete: true, daclPresent: true,
      aces: [{ sid: currentUserSid, mask: 0x001f01ff, deny: false, inheritOnly: false }],
    }),
    stderr: "",
  }));
}

beforeEach(() => configureFsSafeNative({ mode: "off" }));
afterEach(() => __resetFsSafeNativeConfigForTest());

describe("Windows pathname owner locality facts", () => {
  it.each([
    ["omitted", undefined], ["null", null], ["true string", "true"], ["false string", "false"],
    ["zero", 0], ["one", 1], ["object", {}], ["array", []],
  ])("leaves malformed %s locality unverified through both public inspectors", async (_label, remote) => {
    const target = path.join(await tempRoot("fs-safe-owner-locality-"), "fixture");
    await fs.writeFile(target, "unchanged payload", { mode: 0o600 });
    const exec = ownerQuery(remote);
    const permissions = await inspectPathPermissions(target, { platform: "win32", env, exec });
    expect(permissions).toMatchObject({
      ok: true, source: "unknown", ownerError: invalidLocality,
      error: `Windows owner inspection failed: ${invalidLocality}`,
      worldReadable: false, worldWritable: false, groupReadable: false, groupWritable: false,
    });
    expect(permissions.ownerSid).toBeUndefined();
    expect(permissions.ownerTrusted).toBeUndefined();
    const acl = await inspectWindowsAcl(target, { env, exec });
    expect(acl).toEqual({
      ok: false, entries: [], trusted: [], untrustedWorld: [], untrustedGroup: [],
      error: invalidLocality, errorDetail: undefined, errorCause: undefined,
    });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(target, "utf8")).toBe("unchanged payload");
  });

  it.each([
    currentUserSid, "S-1-5-18", "S-1-5-32-544", "S-1-5-21-99",
  ])("preserves explicit local and remote owner policy for %s", async ownerSid => {
    const target = path.join(await tempRoot("fs-safe-owner-locality-valid-"), "fixture");
    await fs.writeFile(target, "unchanged payload", { mode: 0o600 });
    for (const remote of [false, true]) {
      const exec = ownerQuery(remote, ownerSid);
      const permissions = await inspectPathPermissions(target, { platform: "win32", env, exec });
      expect(permissions).toMatchObject({
        ok: true, source: "windows-acl", ownerSid: ownerSid.toLowerCase(),
        ownerTrusted: !remote && ownerSid !== "S-1-5-21-99",
        worldReadable: false, worldWritable: false, groupReadable: false, groupWritable: false,
      });
      expect(permissions.error).toBeUndefined();
      const acl = await inspectWindowsAcl(target, { env, exec });
      expect(acl.ok).toBe(true);
      expect(acl.trusted).toMatchObject([{ sid: currentUserSid.toLowerCase() }]);
      expect(acl.untrustedWorld).toEqual([]);
      expect(acl.untrustedGroup).toEqual([]);
      expect(acl.error).toBeUndefined();
      expect(exec).toHaveBeenCalledTimes(2);
    }
    expect(await fs.readFile(target, "utf8")).toBe("unchanged payload");
  });
});
