import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  __resetNativeLoaderForTest,
  __setNativeLoaderForTest,
  type NativeBinding,
} from "../src/native.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
});

function noReplaceAdapter(rootPath: string, onRename?: () => void) {
  const directoryPaths = new Map<number, string>();
  const openBeneath = vi.fn((
    _rootFd: number,
    relativePath: string,
    flags: number,
  ) => {
    const directoryPath = relativePath
      ? path.join(rootPath, ...relativePath.split("/"))
      : rootPath;
    const fd = fsSync.openSync(directoryPath, flags);
    directoryPaths.set(fd, directoryPath);
    return { fd, containment: "best-effort" as const };
  });
  const renameNoReplace = vi.fn((
    sourceParentFd: number,
    sourceName: string,
    targetParentFd: number,
    targetName: string,
  ) => {
    onRename?.();
    const sourceParent = directoryPaths.get(sourceParentFd);
    const targetParent = directoryPaths.get(targetParentFd);
    if (!sourceParent || !targetParent) throw new Error("unadmitted test directory");
    const source = path.join(sourceParent, sourceName);
    const target = path.join(targetParent, targetName);
    try {
      fsSync.lstatSync(target);
      throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fsSync.renameSync(source, target);
  });
  const binding = { openBeneath, renameNoReplace } as unknown as NativeBinding;
  return { binding, openBeneath, renameNoReplace };
}

it("preserves a competitor target created after no-replace move admission", async () => {
  const directory = await tempRoot("fs-safe-root-move-race-");
  await fs.mkdir(path.join(directory, "incoming"));
  await fs.mkdir(path.join(directory, "archive"));
  const source = path.join(directory, "incoming", "source.txt");
  const target = path.join(directory, "archive", "target.txt");
  await fs.writeFile(source, "source");
  const adapter = noReplaceAdapter(directory);
  __setNativeLoaderForTest(() => adapter.binding);
  configureFsSafeNative({ mode: "require" });
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation: async (operation) => {
      if (operation !== "move") return;
      expect(adapter.openBeneath).toHaveBeenCalledTimes(2);
      await fs.writeFile(target, "competitor");
    },
  });

  const scoped = await root(directory);
  await expect(scoped.move("incoming/source.txt", "archive/target.txt"))
    .rejects.toMatchObject({ code: "already-exists" });

  expect(adapter.renameNoReplace).toHaveBeenCalledOnce();
  await expect(fs.readFile(source, "utf8")).resolves.toBe("source");
  await expect(fs.readFile(target, "utf8")).resolves.toBe("competitor");
});

it("dispatches successful no-replace moves through admitted native parent descriptors", async () => {
  const directory = await tempRoot("fs-safe-root-move-native-");
  await fs.mkdir(path.join(directory, "incoming"));
  await fs.mkdir(path.join(directory, "archive"));
  const source = path.join(directory, "incoming", "source.txt");
  const target = path.join(directory, "archive", "target.txt");
  await fs.writeFile(source, "source");
  const events: string[] = [];
  const adapter = noReplaceAdapter(directory, () => events.push("renameNoReplace"));
  __setNativeLoaderForTest(() => adapter.binding);
  configureFsSafeNative({ mode: "require" });

  const scoped = await root(directory);
  await scoped.move("incoming/source.txt", "archive/target.txt", {
    assertBeforeMutation: () => events.push("assertBeforeMutation"),
  });

  expect(adapter.openBeneath.mock.calls.map((call) => call[1])).toEqual(["incoming", "archive"]);
  expect(adapter.renameNoReplace).toHaveBeenCalledWith(
    expect.any(Number),
    "source.txt",
    expect.any(Number),
    "target.txt",
  );
  expect(events).toEqual(["assertBeforeMutation", "renameNoReplace"]);
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(target, "utf8")).resolves.toBe("source");
});

it("shares one native parent admission for an exact same-parent move", async () => {
  const directory = await tempRoot("fs-safe-root-move-same-parent-");
  await fs.writeFile(path.join(directory, "source.txt"), "source");
  const adapter = noReplaceAdapter(directory);
  __setNativeLoaderForTest(() => adapter.binding);
  configureFsSafeNative({ mode: "require" });

  const scoped = await root(directory);
  await scoped.move("source.txt", "target.txt");

  expect(adapter.openBeneath).toHaveBeenCalledOnce();
  expect(adapter.openBeneath).toHaveBeenCalledWith(expect.any(Number), "", expect.any(Number));
  const [sourceParentFd, , targetParentFd] = adapter.renameNoReplace.mock.calls[0]!;
  expect(sourceParentFd).toBe(targetParentFd);
  await expect(fs.lstat(path.join(directory, "source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(path.join(directory, "target.txt"), "utf8")).resolves.toBe("source");
});

it("keeps the requested basename under an admitted contained parent alias", async () => {
  const directory = await tempRoot("fs-safe-root-move-parent-alias-");
  const actual = path.join(directory, "actual");
  await fs.mkdir(actual);
  await fs.writeFile(path.join(actual, "source.txt"), "source");
  await fs.symlink(actual, path.join(directory, "alias"), process.platform === "win32" ? "junction" : "dir");
  const adapter = noReplaceAdapter(directory);
  __setNativeLoaderForTest(() => adapter.binding);
  configureFsSafeNative({ mode: "require" });

  const scoped = await root(directory);
  await scoped.move("alias/source.txt", "target.txt", {
    mutationSymlinks: "follow-parents-within-root",
  });

  expect(adapter.openBeneath.mock.calls.map((call) => call[1])).toEqual(["actual", ""]);
  expect(adapter.renameNoReplace).toHaveBeenCalledWith(
    expect.any(Number),
    "source.txt",
    expect.any(Number),
    "target.txt",
  );
  await expect(fs.lstat(path.join(actual, "source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(path.join(directory, "target.txt"), "utf8")).resolves.toBe("source");
});

it("fails closed when no native no-replace move helper is available", async () => {
  const directory = await tempRoot("fs-safe-root-move-unavailable-");
  const source = path.join(directory, "source.txt");
  const target = path.join(directory, "target.txt");
  await fs.writeFile(source, "source");
  const loader = vi.fn(() => noReplaceAdapter(directory).binding);
  __setNativeLoaderForTest(loader);
  configureFsSafeNative({ mode: "off" });

  const scoped = await root(directory);
  await expect(scoped.move("source.txt", "target.txt"))
    .rejects.toMatchObject({ code: "helper-unavailable" });

  expect(loader).not.toHaveBeenCalled();
  await expect(fs.readFile(source, "utf8")).resolves.toBe("source");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails closed when the loaded binding lacks bounded parent admission", async () => {
  const directory = await tempRoot("fs-safe-root-move-unbounded-");
  const source = path.join(directory, "source.txt");
  const target = path.join(directory, "target.txt");
  await fs.writeFile(source, "source");
  const renameNoReplace = vi.fn();
  __setNativeLoaderForTest(() => ({ renameNoReplace }) as unknown as NativeBinding);
  configureFsSafeNative({ mode: "require" });

  const scoped = await root(directory);
  await expect(scoped.move("source.txt", "target.txt"))
    .rejects.toMatchObject({ code: "helper-unavailable" });

  expect(renameNoReplace).not.toHaveBeenCalled();
  await expect(fs.readFile(source, "utf8")).resolves.toBe("source");
  await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
});

it("maps renameNoReplace EINVAL to helper-unavailable only at native dispatch", async () => {
  const directory = await tempRoot("fs-safe-root-move-unsupported-fs-");
  await fs.writeFile(path.join(directory, "source.txt"), "source");
  const nativeFailure = Object.assign(new Error("renameat2 unsupported by filesystem"), { code: "EINVAL" });
  const adapter = noReplaceAdapter(directory, () => { throw nativeFailure; });
  __setNativeLoaderForTest(() => adapter.binding);
  configureFsSafeNative({ mode: "require" });

  const scoped = await root(directory);
  await expect(scoped.move("source.txt", "target.txt")).rejects.toMatchObject({
    code: "helper-unavailable",
    cause: nativeFailure,
  });

  const unrelatedFailure = Object.assign(new Error("policy rejected input"), { code: "EINVAL" });
  __setFsSafeTestHooksForTest({
    beforeRootFallbackMutation: async () => { throw unrelatedFailure; },
  });
  await expect(scoped.move("source.txt", "other.txt")).rejects.toBe(unrelatedFailure);
});

it("preserves move and close failures without a global SuppressedError constructor", async () => {
  const directory = await tempRoot("fs-safe-root-move-suppressed-fallback-");
  await fs.writeFile(path.join(directory, "source.txt"), "source");
  const operationFailure = Object.assign(new Error("rename failed"), { code: "EIO" });
  const closeFailure = Object.assign(new Error("close failed"), { code: "EIO" });
  const adapter = noReplaceAdapter(directory, () => { throw operationFailure; });
  __setNativeLoaderForTest(() => adapter.binding);
  configureFsSafeNative({ mode: "require" });
  const realClose = fsSync.closeSync.bind(fsSync);
  let injectCloseFailure = true;
  vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
    realClose(fd);
    if (injectCloseFailure) {
      injectCloseFailure = false;
      throw closeFailure;
    }
  });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "SuppressedError");
  expect(Reflect.deleteProperty(globalThis, "SuppressedError")).toBe(true);
  try {
    const scoped = await root(directory);
    await expect(scoped.move("source.txt", "target.txt")).rejects.toMatchObject({
      name: "SuppressedError",
      error: closeFailure,
      suppressed: operationFailure,
    });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "SuppressedError", descriptor);
  }
});

it("keeps overwrite moves on the existing JavaScript rename path", async () => {
  const directory = await tempRoot("fs-safe-root-move-overwrite-");
  const source = path.join(directory, "source.txt");
  const target = path.join(directory, "target.txt");
  await fs.writeFile(source, "source");
  await fs.writeFile(target, "target");
  const loader = vi.fn(() => noReplaceAdapter(directory).binding);
  __setNativeLoaderForTest(loader);
  configureFsSafeNative({ mode: "off" });
  const rename = fs.rename.bind(fs);
  const renameSpy = vi.spyOn(fs, "rename").mockImplementation(
    async (...args: Parameters<typeof fs.rename>) => await rename(...args),
  );

  const scoped = await root(directory);
  await scoped.move("source.txt", "target.txt", { overwrite: true });

  expect(loader).not.toHaveBeenCalled();
  expect(renameSpy).toHaveBeenCalledWith(source, target);
  await expect(fs.lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(target, "utf8")).resolves.toBe("source");
});

it("continues to reject no-replace directory moves", async () => {
  const directory = await tempRoot("fs-safe-root-move-directory-");
  await fs.mkdir(path.join(directory, "source"));
  const adapter = noReplaceAdapter(directory);
  __setNativeLoaderForTest(() => adapter.binding);
  configureFsSafeNative({ mode: "require" });

  const scoped = await root(directory);
  await expect(scoped.move("source", "target"))
    .rejects.toMatchObject({ code: "invalid-path" });
  expect(adapter.renameNoReplace).not.toHaveBeenCalled();
  expect((await fs.stat(path.join(directory, "source"))).isDirectory()).toBe(true);
});
