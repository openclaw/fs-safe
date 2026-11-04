import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, getFsSafeNativeConfig, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __loadBundledNativeForTest, __resetNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { inspectPathPermissions } from "../src/permissions.js";
import { readSecureFile } from "../src/secure-file.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const installer = "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const otherService = "s-1-5-80-0";
const { tempRoot } = useRealTempDirs();
let native: NativeBinding | undefined;
if (process.platform === "win32") {
  try { native = __loadBundledNativeForTest(); }
  catch (error) { if (getFsSafeNativeConfig().mode === "require") throw error; }
  if (getFsSafeNativeConfig().mode === "require" && !native?.readOwnerAndDacl) {
    throw new Error("Required native Windows ACL reader is unavailable");
  }
}

function rule(target: string, operation: "/grant" | "/deny", sid: string, rights: string) {
  execFileSync(resolveWindowsSystemCommand("icacls.exe"), [target, operation, `*${sid}:${rights}`, "/q"], {
    stdio: "pipe", windowsHide: true, timeout: 30_000,
  });
}

describe.runIf(process.platform === "win32" && !!native?.readOwnerAndDacl)("real Windows public permission boundaries", () => {
  let directory: string;
  beforeEach(async () => {
    configureFsSafeNative({ mode: "require" });
    __resetNativeLoaderForTest();
    directory = path.join(await tempRoot("fs-safe-servicing-acl-"), "private");
    native!.createPrivateDirectory(directory);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetFsSafeNativeConfigForTest();
    __resetNativeLoaderForTest();
  });

  it.each([
    ["TrustedInstaller", installer, false, false],
    ["unrelated service", otherService, true, false],
    ["LocalService", "s-1-5-19", true, false],
    ["Users", "s-1-5-32-545", false, true],
    ["Everyone", "s-1-1-0", false, true],
  ] as const)("classifies a real %s writer identically without weakening native strict facts", async (_name, sid, groupWritable, worldWritable) => {
    rule(directory, "/grant", sid, "(OI)(CI)F");
    const observations = native!.readOwnerAndDacl(directory);
    expect(observations).toMatchObject({
      fallbackRequired: false, aceListComplete: true, isLocal: true,
    });
    expect(["current-user", "administrators"]).toContain(observations.ownerClass);
    expect(observations.aces).toContainEqual(expect.objectContaining({
      sid, mask: 0x001f01ff, aceType: "allow",
      flags: expect.objectContaining({ inheritOnly: false }),
    }));
    expect(observations.groupWritable || observations.worldWritable).toBe(true);
    const exec = vi.fn(async () => { throw new Error("Unexpected native fallback"); });
    const direct = await inspectPathPermissions(directory, { exec });
    expect(exec).not.toHaveBeenCalled();
    configureFsSafeNative({ mode: "off" });
    const fallback = await inspectPathPermissions(directory);
    for (const result of [direct, fallback]) {
      expect(result).toMatchObject({
        ok: true, source: "windows-acl", ownerTrusted: true, groupWritable, worldWritable,
      });
    }
    for (const key of ["groupReadable", "groupWritable", "worldReadable", "worldWritable"] as const) {
      expect(direct[key]).toBe(fallback[key]);
    }
  });

  it.each([
    ["deny", "/deny", "F", "deny", false],
    ["inherit-only", "/grant", "(OI)(CI)(IO)F", "allow", true],
  ] as const)("does not count a real unrelated-service %s entry as an object grant", async (_name, operation, rights, aceType, inheritOnly) => {
    rule(directory, operation, otherService, rights);
    expect(native!.readOwnerAndDacl(directory).aces).toContainEqual(expect.objectContaining({
      sid: otherService, aceType, flags: expect.objectContaining({ inheritOnly }),
    }));
    for (const mode of ["require", "off"] as const) {
      configureFsSafeNative({ mode });
      await expect(inspectPathPermissions(directory)).resolves.toMatchObject({
        ok: true, source: "windows-acl", groupWritable: false, worldWritable: false,
      });
    }
  });

  it("uses the same public policy for a real inherited servicing grant", async () => {
    rule(directory, "/grant", installer, "(OI)(CI)F");
    const child = path.join(directory, "inherited");
    await fs.mkdir(child);
    expect(native!.readOwnerAndDacl(child)).toMatchObject({
      fallbackRequired: false, groupWritable: true,
      aces: expect.arrayContaining([expect.objectContaining({
        sid: installer, aceType: "allow", mask: 0x001f01ff,
        flags: expect.objectContaining({ inherited: true, inheritOnly: false }),
      })]),
    });
    for (const mode of ["require", "off"] as const) {
      configureFsSafeNative({ mode });
      await expect(inspectPathPermissions(child)).resolves.toMatchObject({
        source: "windows-acl", ownerTrusted: true, groupWritable: false, worldWritable: false,
      });
    }
  });

  it("retains a real untrusted allow grant alongside a deny entry", async () => {
    rule(directory, "/deny", otherService, "W");
    rule(directory, "/grant", "s-1-5-19", "F");
    const entries = native!.readOwnerAndDacl(directory).aces.filter(ace =>
      ace.sid === otherService || ace.sid === "s-1-5-19");
    expect(entries.map(ace => [ace.sid, ace.aceType])).toEqual([
      [otherService, "deny"], ["s-1-5-19", "allow"],
    ]);
    for (const mode of ["require", "off"] as const) {
      configureFsSafeNative({ mode });
      await expect(inspectPathPermissions(directory)).resolves.toMatchObject({
        source: "windows-acl", groupWritable: true,
      });
    }
  });

  it("refuses real TrustedInstaller-writable private bytes before reading", async () => {
    const filePath = path.join(directory, "secret");
    await fs.writeFile(filePath, "synthetic private bytes");
    rule(filePath, "/grant", installer, "F");
    expect(native!.readOwnerAndDacl(filePath)).toMatchObject({
      fallbackRequired: false, groupWritable: true,
    });
    await expect(inspectPathPermissions(filePath)).resolves.toMatchObject({
      source: "windows-acl", groupWritable: false,
    });
    const open = fs.open.bind(fs);
    const reads: ReturnType<typeof vi.spyOn>[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      reads.push(vi.spyOn(handle, "read"));
      return handle;
    });
    await expect(readSecureFile({ filePath })).rejects.toMatchObject({ code: "insecure-permissions" });
    expect(reads).toHaveLength(1);
    expect(reads[0]).not.toHaveBeenCalled();
  });
});
