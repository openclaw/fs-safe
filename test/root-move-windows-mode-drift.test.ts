import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import * as windowsRetirement from "../src/windows-source-retirement.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const actualPlatform = process.platform;
const retireWindowsSourceName = windowsRetirement.retireWindowsSourceNameSync;
beforeEach(() => {
  configureFsSafeNative({ mode: "off" });
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
});

async function fixture(mode = 0o666) {
  const directory = await tempRoot("fs-safe-move-readonly-drift-");
  const source = path.join(directory, "source");
  const target = path.join(directory, "target");
  await fs.writeFile(source, "preserve");
  await fs.chmod(source, mode);
  const command = vi.spyOn(windowsRetirement, "retireWindowsSourceNameSync");
  if (actualPlatform !== "win32") {
    const unlink = fsSync.unlinkSync.bind(fsSync);
    // Model the command's committed namespace deletion with a real POSIX
    // unlink. Windows runs the actual metadata-handle command instead.
    command.mockImplementation(input => { unlink(input.sourcePath); });
  }
  const remove = vi.spyOn(fsSync, "unlinkSync");
  return { directory, source, target, remove, command, scoped: await root(directory) };
}

it.each(
  (["awaited-hook", "before-link", "before-retirement"] as const).flatMap(phase =>
    [false, true].map(initiallyReadonly => ({ phase, initiallyReadonly }))),
)("rejects a source read-only change at $phase (initially=$initiallyReadonly) before the next mutation", async ({ phase, initiallyReadonly }) => {
    const nextMode = initiallyReadonly ? 0o666 : 0o444;
    const { source, target, remove, command, scoped } = await fixture(initiallyReadonly ? 0o444 : 0o666);
    if (phase === "awaited-hook") {
      __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: async () => { await fs.chmod(source, nextMode); } });
    }
    let calls = 0;
    const link = vi.spyOn(fsSync, "linkSync");
    await expect(scoped.move("source", "target", {
      assertBeforeMutation: phase === "awaited-hook" ? undefined : () => {
        if (++calls === (phase === "before-link" ? 1 : 2)) fsSync.chmodSync(source, nextMode);
      },
    })).rejects.toMatchObject({ code: "path-mismatch" });
    expect(link).toHaveBeenCalledTimes(phase === "before-retirement" ? 1 : 0);
    expect(remove).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect((await fs.stat(source)).mode & 0o200).toBe(nextMode & 0o200);
    expect(await fs.readFile(source, "utf8")).toBe("preserve");
    if (phase === "before-retirement") {
      expect((await fs.stat(target)).mode & 0o200).toBe(nextMode & 0o200);
      expect(await fs.readFile(target, "utf8")).toBe("preserve");
    } else await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("preserves an initially read-only source through handle-based retirement without chmod", async () => {
  const { source, target, remove, command, scoped } = await fixture(0o444);
  const chmod = vi.spyOn(fsSync, "fchmodSync");
  await scoped.move("source", "target");
  expect(command).toHaveBeenCalledOnce();
  expect(remove).not.toHaveBeenCalled();
  expect(chmod).not.toHaveBeenCalled();
  expect((await fs.stat(target)).mode & 0o200).toBe(0);
  expect(await fs.readFile(target, "utf8")).toBe("preserve");
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["fstat-fault", "link-drift"] as const)("preserves confirmed Windows retirement before post-delete %s", async fault => {
  const { directory, source, target, command, scoped } = await fixture();
  const retire = command.getMockImplementation() ?? retireWindowsSourceName;
  const fstat = fsSync.fstatSync.bind(fsSync);
  const failure = new Error("post-delete descriptor observation failed");
  let committed = false;
  command.mockImplementation(input => {
    retire(input); committed = true;
    if (fault === "link-drift") fsSync.linkSync(target, path.join(directory, "new-alias"));
  });
  vi.spyOn(fsSync, "fstatSync").mockImplementation((fd, options) => {
    const result = fstat(fd, options);
    if (committed && result.isFile() && fault === "fstat-fault") throw failure;
    return result;
  });
  const error = await scoped.move("source", "target").catch(error => error);
  expect(error).toMatchObject({ details: { sourceConsumed: true } });
  expect(error.details).not.toHaveProperty("sourceRecovery");
  if (fault === "fstat-fault") expect(error.cause).toBe(failure);
  else expect(error.code).toBe("path-mismatch");
  expect(command).toHaveBeenCalledOnce();
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(target, "utf8")).toBe("preserve");
});
