import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it as vitestIt, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import * as linuxRename from "../src/linux-rename-command.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const actualPlatform = process.platform;
const it = vitestIt.skipIf(actualPlatform === "win32");
const runLinuxRename = linuxRename.renameLinuxNoReplaceSync;
beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
  if (actualPlatform !== "linux") {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const open = fsSync.openSync.bind(fsSync);
    // Non-Linux hosts model descriptor admission using real local descriptors.
    vi.spyOn(fsSync, "openSync").mockImplementation((file, flags, mode) => open(file, typeof flags === "number" ? flags & ~0x0020_0000 : flags, mode));
  }
});
afterEach(() => { vi.restoreAllMocks(); __setFsSafeTestHooksForTest(); __resetFsSafeNativeConfigForTest(); });

async function fixture(code = "EPERM") {
  const directory = await tempRoot("fs-safe-linux-no-hardlinks-");
  const source = path.join(directory, "source-é-🦀"), target = path.join(directory, "target-é-🦀");
  await fs.writeFile(source, "original A", { mode: 0o600 });
  const identity = await fs.stat(source, { bigint: true });
  const scoped = await root(directory);
  const failure = Object.assign(new Error("filesystem cannot create hardlinks"), { code });
  const link = vi.spyOn(fsSync, "linkSync").mockImplementation(() => { throw failure; });
  const command = vi.spyOn(linuxRename, "renameLinuxNoReplaceSync");
  if (actualPlatform !== "linux") {
    // These hosts exercise caller settlement. Linux executes the real bridge.
    command.mockImplementation(() => {
      if (fsSync.existsSync(target)) throw new FsSafeError("already-exists", "destination exists", { details: { commit: "not-attempted" } });
      fsSync.renameSync(source, target);
    });
  }
  return { directory, source, target, identity, scoped, failure, link, command };
}

it.each(["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"])("publishes the pinned original after hardlink capability failure %s without repeating admission hooks", async code => {
  const { source, target, identity, scoped, link, command } = await fixture(code);
  const hook = vi.fn(async () => undefined), authority = vi.fn();
  __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: hook });
  const copy = vi.spyOn(fsSync, "copyFileSync"), unlink = vi.spyOn(fsSync, "unlinkSync");
  await scoped.move(path.basename(source), path.basename(target), { assertBeforeMutation: authority });
  expect(link).toHaveBeenCalledOnce();
  expect(command).toHaveBeenCalledOnce();
  expect(command.mock.calls[0]![0].source).toMatchObject({ identity: { dev: identity.dev, ino: identity.ino }, links: 1n, fd: expect.any(Number) });
  expect(hook).toHaveBeenCalledOnce();
  expect(authority).toHaveBeenCalledTimes(2);
  expect(copy).not.toHaveBeenCalled();
  expect(unlink).not.toHaveBeenCalled();
  expect(await fs.stat(target, { bigint: true })).toMatchObject({ dev: identity.dev, ino: identity.ino, mode: identity.mode, nlink: 1n });
  expect(await fs.readFile(target, "utf8")).toBe("original A");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["EIO", "EXDEV", "EINVAL", "EACCES"])("preserves an unclassified hardlink error %s without command dispatch", async code => {
  const { source, target, scoped, failure, command } = await fixture(code);
  await expect(scoped.move(path.basename(source), path.basename(target))).rejects.toBe(failure);
  expect(command).not.toHaveBeenCalled();
  expect(await fs.readFile(source, "utf8")).toBe("original A");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not dispatch a command if the rejected link nevertheless published the source", async () => {
  const realLink = fsSync.linkSync.bind(fsSync);
  const { source, target, scoped, failure, link, command } = await fixture();
  link.mockImplementation((from, to) => { realLink(from, to); throw failure; });
  await expect(scoped.move(path.basename(source), path.basename(target))).rejects.toMatchObject({ code: "path-mismatch" });
  expect(command).not.toHaveBeenCalled();
  expect(await fs.readFile(source, "utf8")).toBe("original A");
  expect(await fs.readFile(target, "utf8")).toBe("original A");
});

it.each(["expired", "source-replacement", "parent-replacement"] as const)("rechecks live authority and the original admissions before fallback: %s", async mutation => {
  const { directory, source, target, scoped, command } = await fixture();
  const failure = new Error("authority expired");
  let calls = 0;
  const changed = path.join(directory, "retired-A");
  const movedDirectory = directory + "-moved";
  const pending = scoped.move(path.basename(source), path.basename(target), { assertBeforeMutation: () => {
    if (++calls !== 2) return;
    if (mutation === "expired") throw failure;
    if (mutation === "source-replacement") { fsSync.renameSync(source, changed); fsSync.writeFileSync(source, "replacement B"); }
    else { fsSync.renameSync(directory, movedDirectory); fsSync.mkdirSync(directory); }
  } });
  try {
    if (mutation === "expired") await expect(pending).rejects.toBe(failure);
    else await expect(pending).rejects.toMatchObject({ code: "path-mismatch" });
    expect(command).not.toHaveBeenCalled();
    const original = mutation === "source-replacement" ? changed : mutation === "parent-replacement" ? path.join(movedDirectory, path.basename(source)) : source;
    expect(await fs.readFile(original, "utf8")).toBe("original A");
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (mutation === "parent-replacement") { await fs.rmdir(directory); await fs.rename(movedDirectory, directory); }
  }
});

it("refuses a competing destination introduced at command dispatch", async () => {
  const { source, target, scoped, command } = await fixture();
  const perform = command.getMockImplementation() ?? runLinuxRename;
  command.mockImplementation(input => { fsSync.writeFileSync(target, "competitor B", { flag: "wx" }); perform(input); });
  await expect(scoped.move(path.basename(source), path.basename(target))).rejects.toMatchObject({ code: "already-exists" });
  expect(command).toHaveBeenCalledOnce();
  expect(await fs.readFile(source, "utf8")).toBe("original A");
  expect(await fs.readFile(target, "utf8")).toBe("competitor B");
});

it("preserves an unknown reply after committed rename without retry or rollback", async () => {
  const { source, target, scoped, command, link } = await fixture();
  const perform = command.getMockImplementation() ?? runLinuxRename;
  const failure = new FsSafeError("helper-failed", "rename reply lost", { details: { commit: "unknown" } });
  command.mockImplementation(input => { perform(input); throw failure; });
  const unlink = vi.spyOn(fsSync, "unlinkSync");
  await expect(scoped.move(path.basename(source), path.basename(target))).rejects.toBe(failure);
  expect(command).toHaveBeenCalledOnce();
  expect(link).toHaveBeenCalledOnce();
  expect(unlink).not.toHaveBeenCalled();
  expect(await fs.readFile(target, "utf8")).toBe("original A");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
});

it.skipIf(actualPlatform !== "linux" || process.getuid?.() === 0)("uses O_PATH parents and original source pins without directory-read or file-content access", async () => {
  const { directory, source, target, identity, scoped } = await fixture();
  await fs.chmod(source, 0);
  await fs.chmod(directory, 0o300);
  try {
    expect(() => fsSync.openSync(source, fsSync.constants.O_RDONLY)).toThrow(expect.objectContaining({ code: "EACCES" }));
    expect(() => fsSync.openSync(directory, fsSync.constants.O_RDONLY)).toThrow(expect.objectContaining({ code: "EACCES" }));
    await scoped.move(path.basename(source), path.basename(target));
    expect(await fs.stat(target, { bigint: true })).toMatchObject({ dev: identity.dev, ino: identity.ino, nlink: 1n });
    expect((await fs.stat(target)).mode & 0o777).toBe(0);
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await fs.chmod(directory, 0o700); if (fsSync.existsSync(target)) await fs.chmod(target, 0o600); }
});
