import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { publishFileExclusive } from "../src/publish-file.js";
import * as linux from "../src/linux-rename-command.js";
import * as windows from "../src/windows-move-command.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __setFsSafeTestHooksForTest();
});

function blockHardlinks() {
  return vi.spyOn(fsSync, "linkSync").mockImplementation(() => {
    throw Object.assign(new Error("filesystem cannot link"), { code: "ENOTSUP" });
  });
}

async function fixture() {
  const dir = await tempRoot("fs-safe-publication-command-");
  const source = path.join(dir, "source");
  const target = path.join(dir, "target");
  await fs.writeFile(source, "complete original", { mode: 0o600 });
  const publish = () => publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" });
  return { dir, source, target, publish };
}

function mockLinuxParents() {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(linux, "openLinuxRenameParentSync").mockImplementation((directory, expected) => {
    const fd = fsSync.openSync(directory, fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY);
    expect(fsSync.fstatSync(fd, { bigint: true })).toMatchObject({ dev: expected.dev, ino: expected.ino });
    return fd;
  });
}

describe("atomic moving publication without filesystem hardlinks", () => {
  it("uses a real system rename and retains preexisting hardlink aliases", async () => {
    const { dir, source, target, publish } = await fixture();
    const alias = path.join(dir, "existing-alias");
    await fs.link(source, alias);
    const identity = await fs.lstat(source, { bigint: true });
    blockHardlinks();
    const rename = vi.spyOn(fsSync, "renameSync");
    const result = await publish();
    expect(result).toMatchObject({ method: "rename-noreplace", sourceConsumed: true });
    expect(rename).not.toHaveBeenCalled();
    expect(await fs.lstat(target, { bigint: true })).toMatchObject({ dev: identity.dev, ino: identity.ino, mode: identity.mode, nlink: 2n });
    expect(await fs.readFile(target, "utf8")).toBe("complete original");
    expect(await fs.readFile(alias, "utf8")).toBe("complete original");
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("retains ordinary collision errors and preserves both files", async () => {
    const { source, target, publish } = await fixture();
    await fs.writeFile(target, "sentinel", { mode: 0o600 });
    const identity = await fs.lstat(target, { bigint: true });
    blockHardlinks();
    await expect(publish()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(source, "utf8")).toBe("complete original");
    expect(await fs.readFile(target, "utf8")).toBe("sentinel");
    expect(await fs.lstat(target, { bigint: true })).toMatchObject({ dev: identity.dev, ino: identity.ino });
  }, 30_000);

  it.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
    "does not add source-parent read permission to the atomic command route", async () => {
      const { dir, target } = await fixture();
      const parent = path.join(dir, "write-search-parent");
      await fs.mkdir(parent, { mode: 0o700 });
      const source = path.join(parent, "source");
      await fs.writeFile(source, "private source", { mode: 0o600 });
      await fs.chmod(parent, 0o300);
      blockHardlinks();
      try {
        await expect(fs.open(parent, "r")).rejects.toMatchObject({ code: "EACCES" });
        const result = await publishFileExclusive({ sourcePath: source, targetPath: target, strategy: "rename-noreplace" });
        expect(result).toMatchObject({ method: "rename-noreplace", sourceConsumed: true });
        expect(await fs.readFile(target, "utf8")).toBe("private source");
      } finally {
        await fs.chmod(parent, 0o700);
      }
      expect(await fs.readdir(parent)).toEqual([]);
    }, 30_000,
  );

  it("records command publication before an observer rejects it", async () => {
    const { source, target, publish } = await fixture();
    blockHardlinks();
    const failure = new Error("observer rejected publication");
    __setFsSafeTestHooksForTest({
      afterPublishTargetCreated(method) {
        expect(method).toBe("rename-noreplace");
        throw failure;
      },
    });
    await expect(publish()).rejects.toMatchObject({ cause: failure, details: {
      targetCreated: true, sourceConsumed: true, cleanup: "preserved", phase: "rename-verify",
    } });
    expect(await fs.readFile(target, "utf8")).toBe("complete original");
    await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it.skipIf(process.platform === "win32")("preserves an unknown Linux command outcome without retry", async () => {
    const { source, target, publish } = await fixture();
    const link = blockHardlinks();
    mockLinuxParents();
    const command = vi.spyOn(linux, "renameLinuxNoReplaceSync").mockImplementation((input) => {
      expect(fsSync.fstatSync(input.source.fd!, { bigint: true })).toMatchObject(input.source.identity);
      fsSync.renameSync(source, target);
      throw new FsSafeError("helper-failed", "reply unavailable", { details: { commit: "unknown" } });
    });
    await expect(publish()).rejects.toMatchObject({ details: { commit: "unknown" } });
    expect(command).toHaveBeenCalledOnce();
    expect(link).toHaveBeenCalledOnce();
    expect(await fs.readFile(target, "utf8")).toBe("complete original");
  });

  it.skipIf(process.platform === "win32")("retains both files when Linux command setup is unavailable", async () => {
    const { source, target, publish } = await fixture();
    blockHardlinks();
    mockLinuxParents();
    vi.spyOn(linux, "renameLinuxNoReplaceSync").mockImplementation(() => {
      throw new FsSafeError("helper-unavailable", "runtime unavailable", { details: { commit: "not-attempted" } });
    });
    await expect(publish()).rejects.toMatchObject({ code: "helper-unavailable", details: { commit: "not-attempted" } });
    expect(await fs.readFile(source, "utf8")).toBe("complete original");
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a Windows command's committed outcome when post-verification fails", async () => {
    const { source, target, publish } = await fixture();
    blockHardlinks();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(windows, "moveWindowsFileNoReplaceSync").mockImplementation((input) => {
      expect(input.source.expectedLinks).toBe(1n);
      fsSync.renameSync(source, target);
      throw new FsSafeError("helper-failed", "verification failed", { details: { commit: "committed" } });
    });
    await expect(publish()).rejects.toMatchObject({ details: {
      targetCreated: true, sourceConsumed: true, phase: "rename-verify", cleanup: "preserved",
    } });
    expect(await fs.readFile(target, "utf8")).toBe("complete original");
  });
});
