import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { resolveRootContext } from "../src/root-context.js";
import { movePathNoReplaceWithCommand } from "../src/root-move-command.js";
import { movePathNoReplaceNative } from "../src/root-move-noreplace.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

vi.mock("../src/root-move-command.js", () => ({ movePathNoReplaceWithCommand: vi.fn() }));
const command = vi.mocked(movePathNoReplaceWithCommand);
const { tempRoot } = useRealTempDirs();

beforeEach(() => {
  command.mockReset();
  command.mockImplementation(async (_root, _options, paths) => {
    // Controlled absent-target fixture; adapter integration tests own atomicity.
    fsSync.renameSync(paths.sourcePath, paths.targetPath);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
});

async function fixture() {
  const directory = await tempRoot("fs-safe-root-command-selection-");
  const source = path.join(directory, "source");
  const target = path.join(directory, "target");
  await fs.writeFile(source, "original source");
  const identity = await fs.stat(source, { bigint: true });
  const context = await resolveRootContext(directory);
  return {
    directory, source, target, identity, context,
    paths: { sourcePath: source, targetPath: target, sourceParentPath: directory, targetParentPath: directory },
  };
}

function adapter(directory: string, failure?: unknown) {
  const directories = new Map<number, string>();
  const binding = {
    closeOwnedFd: vi.fn((fd: number) => fsSync.closeSync(fd)),
    openBeneath: vi.fn((_root: number, relative: string, flags: number) => {
      const parent = path.join(directory, relative);
      const fd = fsSync.openSync(parent, flags);
      directories.set(fd, parent);
      return { fd, containment: "best-effort" as const };
    }),
    renameNoReplace: vi.fn((sourceFd: number, sourceName: string, targetFd: number, targetName: string) => {
      if (failure) throw failure;
      fsSync.renameSync(path.join(directories.get(sourceFd)!, sourceName), path.join(directories.get(targetFd)!, targetName));
    }),
  };
  return binding;
}

describe.each(["addon", "renameNoReplace", "openBeneath", "closeOwnedFd"] as const)(
  "missing native %s", missing => {
    it("selects the command before native dispatch in auto mode", async () => {
      const f = await fixture();
      const binding = adapter(f.directory);
      const loader = vi.fn(() => {
        if (missing === "addon") throw new Error("missing addon");
        return { ...binding, [missing]: undefined } as unknown as NativeBinding;
      });
      __setNativeLoaderForTest(loader);
      configureFsSafeNative({ mode: "auto" });

      await movePathNoReplaceNative(f.context, {}, f.paths);

      expect(command).toHaveBeenCalledOnce();
      expect(loader).toHaveBeenCalledOnce();
      expect(binding.openBeneath).not.toHaveBeenCalled();
      expect(binding.renameNoReplace).not.toHaveBeenCalled();
      expect((await fs.stat(f.target, { bigint: true })).ino).toBe(f.identity.ino);
      await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("fails closed in require mode without command or destination effects", async () => {
      const f = await fixture();
      const binding = adapter(f.directory);
      __setNativeLoaderForTest(() => {
        if (missing === "addon") throw new Error("missing addon");
        return { ...binding, [missing]: undefined } as unknown as NativeBinding;
      });
      configureFsSafeNative({ mode: "require" });
      const link = vi.spyOn(fs, "link");
      const copy = vi.spyOn(fs, "copyFile");
      const unlink = vi.spyOn(fs, "unlink");

      await expect(movePathNoReplaceNative(f.context, {}, f.paths)).rejects.toMatchObject({ code: "helper-unavailable" });

      expect(command).not.toHaveBeenCalled();
      expect(binding.openBeneath).not.toHaveBeenCalled();
      expect(binding.renameNoReplace).not.toHaveBeenCalled();
      expect(link).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
      expect((await fs.stat(f.source, { bigint: true })).ino).toBe(f.identity.ino);
      await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

it("uses off mode without trying to load the installed addon", async () => {
  const f = await fixture();
  const binding = adapter(f.directory);
  const loader = vi.fn(() => binding as unknown as NativeBinding);
  __setNativeLoaderForTest(loader);
  configureFsSafeNative({ mode: "off" });
  await movePathNoReplaceNative(f.context, {}, f.paths);
  expect(loader).not.toHaveBeenCalled();
  expect(command).toHaveBeenCalledOnce();
  expect(binding.renameNoReplace).not.toHaveBeenCalled();
  expect((await fs.stat(f.target, { bigint: true })).ino).toBe(f.identity.ino);
});

it.each(["auto", "off", "require"] as const)("retains destination-exists precedence in %s mode", async mode => {
  const f = await fixture();
  await fs.writeFile(f.target, "competitor");
  const loader = vi.fn(() => { throw new Error("missing addon"); });
  __setNativeLoaderForTest(loader);
  configureFsSafeNative({ mode });
  await expect(movePathNoReplaceNative(f.context, {}, f.paths)).rejects.toMatchObject({ code: "already-exists" });
  expect(loader).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled();
  expect(await fs.readFile(f.target, "utf8")).toBe("competitor");
});

it.each(["auto", "require"] as const)("checks legacy numeric Windows root identity capability in %s mode", async mode => {
  const f = await fixture();
  const binding = adapter(f.directory);
  __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
  configureFsSafeNative({ mode });
  const context = { ...f.context, rootIdentity: { dev: Number(f.context.rootIdentity.dev), ino: Number(f.context.rootIdentity.ino) } };
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  if (mode === "require") {
    await expect(movePathNoReplaceNative(context, {}, f.paths)).rejects.toMatchObject({ code: "helper-unavailable" });
    expect(command).not.toHaveBeenCalled();
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    await movePathNoReplaceNative(context, {}, f.paths);
    expect(command).toHaveBeenCalledOnce();
    expect((await fs.stat(f.target, { bigint: true })).ino).toBe(f.identity.ino);
  }
  expect(binding.openBeneath).not.toHaveBeenCalled();
  expect(binding.renameNoReplace).not.toHaveBeenCalled();
});

describe.each(["auto", "require"] as const)("native backend in %s mode", mode => {
  it.each(["ENOSYS", "EINVAL", "EIO", "EACCES"])("never retries native rename %s", async code => {
    const f = await fixture();
    const failure = Object.assign(new Error("native failure"), { code });
    const binding = adapter(f.directory, failure);
    __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
    configureFsSafeNative({ mode });
    const link = vi.spyOn(fs, "link");
    const copy = vi.spyOn(fs, "copyFile");
    const unlink = vi.spyOn(fs, "unlink");

    await expect(movePathNoReplaceNative(f.context, {}, f.paths)).rejects.toMatchObject(
      code === "ENOSYS" || code === "EINVAL" ? { code: "helper-unavailable", cause: failure } : { code },
    );
    expect(command).not.toHaveBeenCalled();
    expect(binding.renameNoReplace).toHaveBeenCalledOnce();
    expect(binding.closeOwnedFd).toHaveBeenCalledOnce();
    expect(link).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect((await fs.stat(f.source, { bigint: true })).ino).toBe(f.identity.ino);
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["hook", "authority", "close"] as const)("never retries a native %s failure", async phase => {
    const f = await fixture();
    const failure = Object.assign(new Error(`${phase} failure`), { code: "EIO" });
    const binding = adapter(f.directory);
    if (phase === "close") binding.closeOwnedFd.mockImplementation(fd => { fsSync.closeSync(fd); throw failure; });
    if (phase === "hook") __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: () => { throw failure; } });
    __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
    configureFsSafeNative({ mode });

    await expect(movePathNoReplaceNative(f.context, {
      assertBeforeMutation: phase === "authority" ? () => { throw failure; } : undefined,
    }, f.paths)).rejects.toBe(failure);

    expect(command).not.toHaveBeenCalled();
    expect(binding.renameNoReplace).toHaveBeenCalledTimes(phase === "close" ? 1 : 0);
    expect((await fs.stat(phase === "close" ? f.target : f.source, { bigint: true })).ino).toBe(f.identity.ino);
  });

  it("keeps native success on its existing descriptor path", async () => {
    const f = await fixture();
    const binding = adapter(f.directory);
    __setNativeLoaderForTest(() => binding as unknown as NativeBinding);
    configureFsSafeNative({ mode });
    const scoped = await root(f.directory);
    await scoped.move("source", "target");
    expect(binding.renameNoReplace).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalled();
    expect((await fs.stat(f.target, { bigint: true })).ino).toBe(f.identity.ino);
  });
});
