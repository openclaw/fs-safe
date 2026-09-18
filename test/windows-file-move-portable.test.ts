import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { moveWindowsFileNoReplaceSync, type WindowsFileMoveCommandInput } from "../src/windows-move-command.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
function setDirectoryListAcl(directories: string[], deny: boolean): void {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]9,[Security.AccessControl.AccessControlType]::Deny)",
    "$paths=ConvertFrom-Json ([Environment]::GetEnvironmentVariable('FS_SAFE_FILE_MOVE_PARENTS'))",
    "foreach($p in $paths){$acl=[IO.Directory]::GetAccessControl($p)",
    deny ? "$acl.AddAccessRule($rule)" : "$acl.RemoveAccessRuleSpecific($rule)",
    "[IO.Directory]::SetAccessControl($p,$acl)}",
  ].join(";");
  execFileSync(resolveWindowsSystemCommand(String.raw`WindowsPowerShell\v1.0\powershell.exe`), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], { windowsHide: true, stdio: "pipe", timeout: 30_000, env: { ...process.env, FS_SAFE_FILE_MOVE_PARENTS: JSON.stringify(directories) } });
}
async function fixture(links = 1) {
  const sourceParent = await tempRoot("fs-safe-win-file-move-in-");
  const targetParent = await tempRoot("fs-safe-win-file-move-out-");
  const source = path.join(sourceParent, "source"), target = path.join(targetParent, "target");
  await fs.writeFile(source, "complete public payload");
  const aliases = Array.from({ length: links - 1 }, (_, index) => path.join(sourceParent, `alias-${index}`));
  for (const alias of aliases) await fs.link(source, alias);
  const identity = await fs.stat(source, { bigint: true });
  const input: WindowsFileMoveCommandInput = {
    source: { parentPath: sourceParent, parentIdentity: await fs.stat(sourceParent, { bigint: true }), basename: "source", identity, expectedLinks: identity.nlink },
    target: { parentPath: targetParent, parentIdentity: await fs.stat(targetParent, { bigint: true }), basename: "target" },
  };
  return { sourceParent, targetParent, source, target, aliases, identity, input };
}

describe.runIf(process.platform === "win32")("Windows independent-parent atomic file moves", () => {
  it.each([1, 3])("preserves the exact inode and %s existing links between independent parents", async links => {
    const f = await fixture(links);
    moveWindowsFileNoReplaceSync(f.input);
    await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
    for (const file of [f.target, ...f.aliases]) {
      expect(await fs.stat(file, { bigint: true })).toMatchObject({ dev: f.identity.dev, ino: f.identity.ino, nlink: BigInt(links), mode: f.identity.mode });
      expect(await fs.readFile(file, "utf8")).toBe("complete public payload");
    }
  }, 35_000);

  it("reports a collision as uncommitted and permits another no-replace destination", async () => {
    const f = await fixture(2);
    await fs.writeFile(f.target, "sentinel");
    const sentinel = await fs.stat(f.target, { bigint: true });
    expect(() => moveWindowsFileNoReplaceSync(f.input)).toThrow(expect.objectContaining({ code: "EEXIST", phase: "rename", commit: "not-attempted" }));
    expect(await fs.stat(f.target, { bigint: true })).toMatchObject({ dev: sentinel.dev, ino: sentinel.ino });
    expect(await fs.readFile(f.target, "utf8")).toBe("sentinel");
    expect(await fs.stat(f.source, { bigint: true })).toMatchObject({ dev: f.identity.dev, ino: f.identity.ino, nlink: 2n });
    f.input.target.basename = "second";
    moveWindowsFileNoReplaceSync(f.input);
    expect(await fs.stat(path.join(f.targetParent, "second"), { bigint: true })).toMatchObject({ dev: f.identity.dev, ino: f.identity.ino, nlink: 2n });
  }, 65_000);

  it("rejects a changed source link count before mutation", async () => {
    const f = await fixture(2);
    await fs.link(f.source, path.join(f.sourceParent, "late-alias"));
    expect(() => moveWindowsFileNoReplaceSync(f.input)).toThrow(expect.objectContaining({ code: "hardlink", details: expect.objectContaining({ commit: "not-attempted" }) }));
    expect((await fs.stat(f.source, { bigint: true })).nlink).toBe(3n);
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  }, 35_000);

  it("preserves a substituted target parent before mutation", async () => {
    const f = await fixture();
    const saved = path.join(f.targetParent, "original");
    await fs.mkdir(saved);
    f.input.target.parentIdentity = await fs.stat(saved, { bigint: true });
    expect(() => moveWindowsFileNoReplaceSync(f.input)).toThrow(expect.objectContaining({ code: "path-mismatch", details: expect.objectContaining({ commit: "not-attempted" }) }));
    expect((await fs.stat(f.source, { bigint: true })).ino).toBe(f.identity.ino);
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  }, 35_000);

  it("preserves the source read-only mode without applying chmod", async () => {
    const f = await fixture(2);
    await fs.chmod(f.source, 0o400);
    const before = await fs.stat(f.source, { bigint: true });
    try {
      moveWindowsFileNoReplaceSync(f.input);
      expect(await fs.stat(f.target, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, nlink: 2n, mode: before.mode });
      expect(await fs.readFile(f.target, "utf8")).toBe("complete public payload");
    } finally {
      for (const file of [f.source, f.target, ...f.aliases]) if (fsSync.existsSync(file)) fsSync.chmodSync(file, 0o600);
    }
  }, 35_000);

  it("moves without requiring directory listing or extended-attribute read access", async () => {
    const f = await fixture(2);
    const directories = [f.sourceParent, f.targetParent];
    try {
      setDirectoryListAcl(directories, true);
      for (const directory of directories) {
        expect(() => fsSync.readdirSync(directory)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^(EPERM|EACCES)$/) }));
      }
      moveWindowsFileNoReplaceSync(f.input);
      expect(await fs.stat(f.target, { bigint: true })).toMatchObject({ dev: f.identity.dev, ino: f.identity.ino, nlink: 2n });
      await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { setDirectoryListAcl(directories, false); }
    expect(await fs.readFile(f.target, "utf8")).toBe("complete public payload");
  }, 95_000);
});
import { execFileSync } from "node:child_process";
