import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPrivateWindowsDirectoryCommandSync,
  inspectWindowsDirectoryCommandSync,
  protectPrivateWindowsFileCommandSync,
  readWindowsSecurityFactsCommand,
  verifyPrivateWindowsFileCommandSync,
} from "../src/windows-security-command.js";
import { useTempDirs } from "./helpers/vitest.js";
import { runWindowsSecurityScript, WINDOWS_SECURITY_SOURCE } from "./helpers/windows-security-script.js";

const { tempRoot } = useTempDirs();

async function privateStage() {
  const base = await tempRoot("fs-safe-private-file-bridge-");
  const baseReceipt = inspectWindowsDirectoryCommandSync(base, false);
  expect(baseReceipt.identity).toHaveLength(49);
  expect(baseReceipt.identity).toMatch(/^[0-9a-f]{16}:[0-9a-f]{32}$/);
  const stage = path.join(base, "private-é-🦀");
  const createdReceipt = createPrivateWindowsDirectoryCommandSync(stage, baseReceipt.identity);
  const stageReceipt = inspectWindowsDirectoryCommandSync(stage, true);
  expect(createdReceipt).toEqual(stageReceipt);
  return { base, baseReceipt, stage, stageReceipt };
}

function expectPrivateFileAcl(facts: ReturnType<typeof readWindowsSecurityFactsCommand>, protectedDacl: boolean) {
  if (protectedDacl) expect(facts.ownerSid).toBe(facts.currentUserSid);
  else expect([facts.currentUserSid, "s-1-5-32-544"]).toContain(facts.ownerSid);
  expect(facts).toMatchObject({
    daclPresent: true, daclProtected: protectedDacl,
    isLocal: true, aceListComplete: true, unsupportedAceTypes: [],
    worldReadable: false, worldWritable: false, groupReadable: false, groupWritable: false,
  });
  expect(facts.aces.map(ace => ace.sid).sort()).toEqual([facts.currentUserSid, "s-1-5-18", "s-1-5-32-544"].sort());
  for (const ace of facts.aces) expect(ace).toMatchObject({
    aceType: "allow", mask: 0x1f01ff,
    flags: { inherited: !protectedDacl, objectInherit: false, containerInherit: false, inheritOnly: false },
  });
}

function expectBorrowedFileUsable(fd: number, original: fs.BigIntStats) {
  const payload = Buffer.from("still the borrowed file");
  expect(fs.writeSync(fd, payload, 0, payload.length, 0)).toBe(payload.length);
  const read = Buffer.alloc(payload.length);
  expect(fs.readSync(fd, read, 0, read.length, 0)).toBe(payload.length);
  expect(read).toEqual(payload);
  expect(fs.fstatSync(fd, { bigint: true })).toMatchObject({ dev: original.dev, ino: original.ino, nlink: 1n });
}

describe.runIf(process.platform === "win32")("Windows private-file command bridge", () => {
  it("normalizes inherited private-file ownership while retaining the caller's original descriptor", async () => {
    const { base, baseReceipt, stage, stageReceipt } = await privateStage();
    expect(() => createPrivateWindowsDirectoryCommandSync(stage, baseReceipt.identity)).toThrow(expect.objectContaining({ code: "EEXIST" }));
    const rejectedChild = path.join(base, "wrong-parent");
    expect(() => createPrivateWindowsDirectoryCommandSync(rejectedChild, stageReceipt.identity)).toThrow(expect.objectContaining({ code: "EIO" }));
    expect(fs.existsSync(rejectedChild)).toBe(false);
    const file = path.join(stage, "created-file");
    const fd = fs.openSync(file, "wx+", 0o600);
    try {
      const original = fs.fstatSync(fd, { bigint: true });
      expectPrivateFileAcl(readWindowsSecurityFactsCommand(file), false);
      const receipt = protectPrivateWindowsFileCommandSync(fd, file, stageReceipt.identity);
      expect(receipt.identity).toHaveLength(49);
      expect(receipt.identity).toMatch(/^[0-9a-f]{16}:[0-9a-f]{32}$/);
      expectPrivateFileAcl(readWindowsSecurityFactsCommand(file), true);
      verifyPrivateWindowsFileCommandSync(fd, file, receipt.identity, stageReceipt.identity);
      expect(() => verifyPrivateWindowsFileCommandSync(fd, file, receipt.identity, baseReceipt.identity)).toThrow(expect.objectContaining({ code: "EIO" }));
      expectBorrowedFileUsable(fd, original);
    } finally { fs.closeSync(fd); }
  }, 90_000);

  it("rejects a sibling pathname before changing either file's inherited ACL", async () => {
    const { stage, stageReceipt } = await privateStage();
    const originalPath = path.join(stage, "original");
    const siblingPath = path.join(stage, "sibling");
    const fd = fs.openSync(originalPath, "wx+", 0o600);
    try {
      const original = fs.fstatSync(fd, { bigint: true });
      fs.writeFileSync(siblingPath, "sibling stays untouched", { flag: "wx", mode: 0o600 });
      const originalAcl = readWindowsSecurityFactsCommand(originalPath);
      const siblingAcl = readWindowsSecurityFactsCommand(siblingPath);
      expectPrivateFileAcl(originalAcl, false);
      expectPrivateFileAcl(siblingAcl, false);
      expect(() => protectPrivateWindowsFileCommandSync(fd, siblingPath, stageReceipt.identity)).toThrow(expect.objectContaining({ code: "EIO" }));
      expect(readWindowsSecurityFactsCommand(originalPath)).toEqual(originalAcl);
      expect(readWindowsSecurityFactsCommand(siblingPath)).toEqual(siblingAcl);
      expect(fs.readFileSync(siblingPath, "utf8")).toBe("sibling stays untouched");
      expectBorrowedFileUsable(fd, original);
    } finally { fs.closeSync(fd); }
  }, 90_000);

  it("rejects effective broad read access without repairing the ACL or consuming the descriptor", async () => {
    const { stage, stageReceipt } = await privateStage();
    const file = path.join(stage, "broad-read");
    const fd = fs.openSync(file, "wx+", 0o600);
    try {
      const original = fs.fstatSync(fd, { bigint: true });
      runWindowsSecurityScript(WINDOWS_SECURITY_SOURCE, [
        "$identity=[Security.Principal.WindowsIdentity]::GetCurrent()",
        "try {",
        "  $acl=[Security.AccessControl.FileSecurity]::new()",
        "  $acl.SetOwner($identity.User)",
        "  $acl.SetAccessRuleProtection($true,$false)",
        "  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))",
        "  $everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
        "  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,[Security.AccessControl.FileSystemRights]::ReadData,[Security.AccessControl.AccessControlType]::Allow))",
        "  [IO.File]::SetAccessControl([Environment]::GetEnvironmentVariable('FS_SAFE_PRIVATE_FILE_TEST_PATH'),$acl)",
        "} finally { $identity.Dispose() }",
      ], { FS_SAFE_PRIVATE_FILE_TEST_PATH: file });
      const before = readWindowsSecurityFactsCommand(file);
      expect(before).toMatchObject({ daclProtected: true, worldReadable: true });
      expect(() => protectPrivateWindowsFileCommandSync(fd, file, stageReceipt.identity)).toThrow(expect.objectContaining({ code: "EACCES" }));
      expect(readWindowsSecurityFactsCommand(file)).toEqual(before);
      expectBorrowedFileUsable(fd, original);
    } finally { fs.closeSync(fd); }
  }, 90_000);

  it("rejects a directory whose inherited-only grant would expose newly created files", async () => {
    const { stage, stageReceipt } = await privateStage();
    runWindowsSecurityScript(WINDOWS_SECURITY_SOURCE, [
      "$identity=[Security.Principal.WindowsIdentity]::GetCurrent()",
      "try {",
      "  $acl=[Security.AccessControl.DirectorySecurity]::new()",
      "  $acl.SetOwner($identity.User)",
      "  $acl.SetAccessRuleProtection($true,$false)",
      "  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow))",
      "  $everyone=[Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
      "  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone,[Security.AccessControl.FileSystemRights]::ReadData,[Security.AccessControl.InheritanceFlags]::ObjectInherit,[Security.AccessControl.PropagationFlags]::InheritOnly,[Security.AccessControl.AccessControlType]::Allow))",
      "  [IO.Directory]::SetAccessControl([Environment]::GetEnvironmentVariable('FS_SAFE_PRIVATE_DIRECTORY_TEST_PATH'),$acl)",
      "} finally { $identity.Dispose() }",
    ], { FS_SAFE_PRIVATE_DIRECTORY_TEST_PATH: stage });
    const before = readWindowsSecurityFactsCommand(stage);
    expect(before).toMatchObject({ daclProtected: true, worldReadable: false, worldWritable: false });
    expect(before.aces).toContainEqual(expect.objectContaining({
      sid: "s-1-1-0", aceType: "allow", flags: expect.objectContaining({ objectInherit: true, inheritOnly: true }),
    }));
    expect(inspectWindowsDirectoryCommandSync(stage, false)).toEqual(stageReceipt);
    expect(() => inspectWindowsDirectoryCommandSync(stage, true)).toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(readWindowsSecurityFactsCommand(stage)).toEqual(before);
  }, 90_000);
});
