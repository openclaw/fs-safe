import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { inspectWindowsAcl } from "../src/permissions-windows.js";
import { executePermissionCommand } from "../src/permission-exec.js";
import { inspectWindowsOwner } from "../src/windows-owner.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { runWindowsSecurityScript } from "./helpers/windows-security-script.js";
import { encodePowerShellCommand, windowsOwnerQueryCommand } from "./helpers/windows-owner-oracle.js";
import { useTempDirs } from "./helpers/vitest.js";

const helper = fileURLToPath(new URL("../src/windows-security-helper.exe", import.meta.url));
const { tempRoot } = useTempDirs();
const commandOptions = { encoding: "utf8", windowsHide: true, timeout: 30_000 } as const;

function oracle(target: string) {
  return JSON.parse(execFileSync(resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    encodePowerShellCommand(windowsOwnerQueryCommand(target)),
  ], commandOptions));
}

// Set and read raw fixture descriptors without .NET's ACL normalization.
const FIXTURE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
public static class OwnerAclFixture {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool SetFileSecurityW(string path,uint sections,byte[] descriptor);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetFileSecurityW(string path,uint sections,byte[] descriptor,uint length,out uint needed);
  public static int[] Set(string path,string sddl) {
    var raw=new RawSecurityDescriptor(sddl);
    var bytes=new byte[raw.BinaryLength]; raw.GetBinaryForm(bytes,0);
    if(!SetFileSecurityW(path,0x80000004,bytes)) throw new Win32Exception(Marshal.GetLastWin32Error());
    uint needed; GetFileSecurityW(path,4,null,0,out needed);
    bytes=new byte[needed];
    if(!GetFileSecurityW(path,4,bytes,needed,out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
    var acl=new RawSecurityDescriptor(bytes,0).DiscretionaryAcl;
    if(acl==null) return new int[0];
    var masks=new int[acl.Count];
    for(int i=0;i<acl.Count;i++) masks[i]=((KnownAce)acl[i]).AccessMask;
    return masks;
  }
}`;

it("uses one helper command and unchanged JSON parser for injected executors", async () => {
  const target = String.raw`C:\space and unicode-é\';$value.txt`;
  const exec = vi.fn(async () => ({ stdout: JSON.stringify({
    ownerSid: "S-1-5-21-42", currentUserSid: "S-1-5-21-42", remote: false,
    complete: true, daclPresent: true, aces: [],
  }), stderr: "" }));
  await expect(inspectWindowsOwner({ targetPath: target, env: { SystemRoot: "D:\\fake" }, exec }))
    .resolves.toMatchObject({ sid: "s-1-5-21-42", trusted: true, aces: [] });
  expect(exec).toHaveBeenCalledExactlyOnceWith(helper, ["owner", target]);
  exec.mockClear();
  await expect(inspectWindowsOwner({ targetPath: `${target}:stream`, exec }))
    .resolves.toMatchObject({ error: expect.stringContaining("namespace alias") });
  expect(exec).not.toHaveBeenCalled();
});

describe.runIf(process.platform === "win32")("prebuilt owner query compatibility", () => {
  it("matches the frozen PowerShell query across paths and normalized descriptors", async () => {
    const root = await tempRoot("fs-safe-owner-helper-");
    const file = path.join(root, "space-é-🦀-';$value.txt");
    const directory = path.join(root, "directory");
    const symlink = path.join(root, "symlink");
    const junction = path.join(root, "junction");
    const zero = path.join(root, "zero-mask"), explicit = path.join(root, "explicit");
    const empty = path.join(root, "empty"), nullDacl = path.join(root, "null");
    await fs.mkdir(directory);
    await Promise.all([file, zero, explicit, empty, nullDacl].map(target => fs.writeFile(target, "fixture")));
    await fs.symlink(file, symlink, "file");
    await fs.symlink(directory, junction, "junction");
    try {
      const setup = JSON.parse(runWindowsSecurityScript(FIXTURE, [
        "$root=[Environment]::GetEnvironmentVariable('FS_SAFE_OWNER_FIXTURE')",
        "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        "$prefix='O:'+$sid+'D:P(A;;FA;;;'+$sid+')'",
        "$zero=[OwnerAclFixture]::Set([IO.Path]::Combine($root,'zero-mask'),$prefix+'(A;;0x0;;;WD)')",
        "$explicit=[OwnerAclFixture]::Set([IO.Path]::Combine($root,'explicit'),$prefix+'(A;;0x1;;;WD)(A;;0x2;;;WD)')",
        "$null=[OwnerAclFixture]::Set([IO.Path]::Combine($root,'empty'),'O:'+$sid+'D:P')",
        "$null=[OwnerAclFixture]::Set([IO.Path]::Combine($root,'null'),'O:'+$sid+'D:NO_ACCESS_CONTROL')",
        "@{zero=@($zero);explicit=@($explicit)}|ConvertTo-Json -Compress",
      ], { FS_SAFE_OWNER_FIXTURE: root }));
      expect(setup.zero).toContain(0);
      expect(setup.explicit.slice(-2)).toEqual([1, 2]);
      // A volume-GUID namespace exercises the old namespace => remote rule
      // without depending on an SMB server or administrative network share.
      const volume = execFileSync(resolveWindowsSystemCommand("mountvol.exe"), [path.parse(root).root, "/L"], commandOptions).trim();
      expect(volume).toMatch(/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i);
      const namespace = volume + file.slice(path.parse(file).root.length);
      const targets = [file, directory, symlink, junction, zero, explicit, empty, nullDacl, `\\\\?\\${file}`, namespace];
      for (const target of targets) {
        const expected = oracle(target);
        const actual = JSON.parse(execFileSync(helper, ["owner", target], commandOptions));
        expect(actual, target).toEqual(expected);
        expect(Object.keys(actual).sort()).toEqual(["aces", "complete", "currentAppContainerSid", "currentUserSid", "daclPresent", "ownerSid", "remote"]);
        expect(actual.remote).toBe(target === namespace);
        if (target === zero) expect(actual.aces.every((ace: { mask: number }) => ace.mask !== 0)).toBe(true);
        if (target === explicit) expect(actual.aces.filter((ace: { sid: string }) => ace.sid === "S-1-1-0").map((ace: { mask: number }) => ace.mask)).toEqual([3]);
        if (target === empty) expect(actual).toMatchObject({ daclPresent: true, aces: [] });
        if (target === nullDacl) expect(actual).toMatchObject({ daclPresent: false, aces: [] });
      }
      const passThrough = vi.fn(executePermissionCommand);
      const injected = await inspectWindowsAcl(file, { exec: passThrough });
      expect(injected.ok).toBe(true);
      expect(passThrough).toHaveBeenCalledExactlyOnceWith(helper, ["owner", file]);
      const canned = await inspectWindowsAcl(file, { exec: async () => ({ stdout: JSON.stringify(oracle(file)), stderr: "" }) });
      expect(injected).toEqual(canned);
    } finally {
      // The owner can restore WRITE_DAC even when the empty DACL denies deletion.
      execFileSync(resolveWindowsSystemCommand("icacls.exe"), [empty, "/reset"], commandOptions);
    }
  }, 45_000);

  it.each([[], ["owner"], ["owner", "x", "extra"], ["path", "extra"], ["unknown"]].map(args => ({ args })))("rejects invalid operation arguments $args", ({ args }) => {
    const result = spawnSync(helper, args, commandOptions);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid Windows security operation");
  });

  it("fails closed for a missing pathname through the same executor", async () => {
    const target = path.join(await tempRoot("fs-safe-owner-missing-"), "missing");
    const result = await inspectWindowsOwner({ targetPath: target, exec: executePermissionCommand });
    expect(result).toMatchObject({ errorDetail: { command: helper, exitCode: 1, timedOut: false } });
    expect(result.sid).toBeUndefined();
    expect(result.trusted).toBeUndefined();
  });
});
