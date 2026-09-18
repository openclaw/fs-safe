import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { root } from "../src/root.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __setNativeLoaderForTest, __resetNativeLoaderForTest } from "../src/native.js";
import { readOwnerAndDacl } from "../src/owner-dacl.js";
import * as command from "../src/windows-move-command.js";
import { useRealTempDirs } from "./helpers/vitest.js";
import { setWindowsMoveFixtureAcl, windowsMoveDataOpenError } from "./helpers/windows-content-rights.js";

const { tempRoot } = useRealTempDirs();
const restricted = new Set<string>();

async function fixture(separate = false) {
  const directory = await tempRoot("fs-safe-win-metadata-move-");
  const incoming = path.join(directory, "incoming"), outgoing = separate ? path.join(directory, "outgoing") : incoming;
  await fs.mkdir(incoming);
  if (outgoing !== incoming) await fs.mkdir(outgoing);
  const source = path.join(incoming, "source-é-'$(literal)"), target = path.join(outgoing, "target-☃");
  await fs.writeFile(source, "content access is unnecessary");
  setWindowsMoveFixtureAcl(source, true); restricted.add(source);
  expect(["EACCES", "EPERM"]).toContain(windowsMoveDataOpenError(source, fsSync.constants.O_RDONLY));
  expect(["EACCES", "EPERM"]).toContain(windowsMoveDataOpenError(source, fsSync.constants.O_WRONLY));
  return { directory, source, target, sourceName: path.relative(directory, source), targetName: path.relative(directory, target), scoped: await root(directory) };
}
function restore(file: string): void {
  if (fsSync.existsSync(file)) setWindowsMoveFixtureAcl(file, false);
  restricted.delete(file);
}

describe.runIf(process.platform === "win32")("Windows portable metadata-only moves", () => {
  beforeEach(() => {
    configureFsSafeNative({ mode: "off" });
    __setNativeLoaderForTest(() => { throw new Error("optional addon deliberately unavailable"); });
    vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const file of restricted) restore(file);
    __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest();
  });

  it.each([
    { mode: "off", separate: false }, { mode: "off", separate: true },
    { mode: "auto", separate: false }, { mode: "auto", separate: true },
  ] as const)("moves the original inode in $mode with separate parents=$separate", async ({ mode, separate }) => {
    const f = await fixture(separate);
    const before = await fs.stat(f.source, { bigint: true });
    const acl = readOwnerAndDacl(f.source);
    expect(acl).toMatchObject({ status: "supported", complete: true });
    if (acl.status !== "supported") throw new Error("Windows ACL facts unavailable");
    expect(acl.aces).toEqual(expect.arrayContaining([
      expect.objectContaining({ sid: acl.currentUserSid, aceType: "deny", mask: 7 }),
      expect.objectContaining({ sid: acl.currentUserSid, aceType: "allow", mask: 0x00130180 }),
    ]));
    configureFsSafeNative({ mode });
    const dispatch = vi.spyOn(command, "moveWindowsMetadataNoReplaceSync");
    const authority = vi.fn();
    restricted.add(f.target);
    await f.scoped.move(f.sourceName, f.targetName, { assertBeforeMutation: authority });
    expect(dispatch).toHaveBeenCalledOnce(); expect(authority).toHaveBeenCalledOnce();
    await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.stat(f.target, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, nlink: 1n, mode: before.mode });
    expect(["EACCES", "EPERM"]).toContain(windowsMoveDataOpenError(f.target, fsSync.constants.O_RDONLY));
    restore(f.target);
    expect(await fs.readFile(f.target, "utf8")).toBe("content access is unnecessary");
  }, 125_000);

  it("retains the read-only attribute without chmod or content access", async () => {
    const f = await fixture();
    await fs.chmod(f.source, 0o400);
    const before = await fs.stat(f.source, { bigint: true });
    const chmod = vi.spyOn(fsSync, "fchmodSync");
    restricted.add(f.target);
    await f.scoped.move(f.sourceName, f.targetName);
    expect(await fs.stat(f.target, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode });
    expect(chmod).not.toHaveBeenCalled();
  }, 65_000);

  it("preserves a competitor created by the last authority callback", async () => {
    const f = await fixture();
    const before = await fs.stat(f.source, { bigint: true });
    const authority = vi.fn(() => fsSync.writeFileSync(f.target, "competitor", { flag: "wx" }));
    await expect(f.scoped.move(f.sourceName, f.targetName, { assertBeforeMutation: authority })).rejects.toMatchObject({ code: "already-exists" });
    expect(authority).toHaveBeenCalledOnce();
    expect(await fs.stat(f.source, { bigint: true })).toMatchObject({ dev: before.dev, ino: before.ino, nlink: 1n });
    expect(await fs.readFile(f.target, "utf8")).toBe("competitor");
  }, 65_000);

  it("does not dispatch after authority expires", async () => {
    const f = await fixture();
    const dispatch = vi.spyOn(command, "moveWindowsMetadataNoReplaceSync");
    const expired = new Error("expired");
    await expect(f.scoped.move(f.sourceName, f.targetName, { assertBeforeMutation: () => { throw expired; } })).rejects.toBe(expired);
    expect(dispatch).not.toHaveBeenCalled();
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  }, 35_000);

  it("preserves a callback source replacement without dispatch", async () => {
    const f = await fixture();
    const retired = path.join(path.dirname(f.source), "retired"); restricted.add(retired);
    const dispatch = vi.spyOn(command, "moveWindowsMetadataNoReplaceSync");
    await expect(f.scoped.move(f.sourceName, f.targetName, { assertBeforeMutation: () => {
      fsSync.renameSync(f.source, retired); fsSync.writeFileSync(f.source, "replacement");
    } })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await fs.readFile(f.source, "utf8")).toBe("replacement");
    restore(retired); expect(await fs.readFile(retired, "utf8")).toBe("content access is unnecessary");
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  }, 65_000);

  it("rejects a hardlink introduced by the callback without dispatch", async () => {
    const f = await fixture(); const alias = path.join(path.dirname(f.source), "alias"); restricted.add(alias);
    const dispatch = vi.spyOn(command, "moveWindowsMetadataNoReplaceSync");
    await expect(f.scoped.move(f.sourceName, f.targetName, { assertBeforeMutation: () => { fsSync.linkSync(f.source, alias); } })).rejects.toMatchObject({ code: "hardlink" });
    expect(dispatch).not.toHaveBeenCalled();
    expect((await fs.stat(f.source, { bigint: true })).nlink).toBe(2n);
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  }, 35_000);
});
