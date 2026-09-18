import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openNativeParentAdmission } from "../src/native-parent-admission.js";
import { windowsPolicyBinding } from "./helpers/windows-policy-binding.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });

it.each([false, true])("admits an exact Windows parent with unavailable native observation=%s", async unavailable => {
  const directory = await tempRoot("fs-safe-native-parent-observation-");
  await fs.mkdir(path.join(directory, "child"));
  const native = windowsPolicyBinding(directory);
  const observe = vi.fn((pathname: string) => {
    if (unavailable) throw Object.assign(new Error("unavailable"), { code: "OBSERVATION_UNAVAILABLE" });
    const stat = fsSync.lstatSync(pathname, { bigint: true });
    return { dev: stat.dev, ino: stat.ino, realPath: fsSync.realpathSync.native(pathname) };
  });
  native.binding.observeDirectory = observe;
  const borrowed = await fs.open(directory, fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0));
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    const admitted = await openNativeParentAdmission(native.binding, {
      root: borrowed, rootPath: directory, exactRoot: true, operation: "test",
    }, "child", "native-directory");
    expect(admitted.guard.realPath).toBe(path.join(directory, "child"));
    expect(admitted.guard.stat.isDirectory()).toBe(true);
    expect(observe).toHaveBeenCalled();
    admitted.close();
    expect(() => fsSync.fstatSync(admitted.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect((await borrowed.stat()).isDirectory()).toBe(true);
  } finally { await borrowed.close(); }
});

it("rejects a named-parent replacement and closes only the owned descriptor", async () => {
  const directory = await tempRoot("fs-safe-native-parent-observation-swap-");
  const child = path.join(directory, "child");
  await fs.mkdir(child);
  const native = windowsPolicyBinding(directory);
  let replaced = false;
  native.binding.observeDirectory = pathname => {
    if (!replaced) {
      replaced = true;
      fsSync.renameSync(child, path.join(directory, "original"));
      fsSync.mkdirSync(child);
    }
    const stat = fsSync.lstatSync(pathname, { bigint: true });
    return { dev: stat.dev, ino: stat.ino, realPath: fsSync.realpathSync.native(pathname) };
  };
  const borrowed = await fs.open(directory, fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY ?? 0));
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await expect(openNativeParentAdmission(native.binding, {
      root: borrowed, rootPath: directory, exactRoot: true, operation: "test",
    }, "child", "native-directory")).rejects.toMatchObject({ code: "path-mismatch" });
    for (const fd of native.opened) {
      expect(() => fsSync.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    }
    expect((await borrowed.stat()).isDirectory()).toBe(true);
    expect((await fs.readdir(directory)).sort()).toEqual(["child", "original"]);
  } finally { await borrowed.close(); }
});
