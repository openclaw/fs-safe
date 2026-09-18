import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { FsSafeError } from "../src/errors.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
});

async function fixture() {
  const directory = await tempRoot("fs-safe-native-move-source-authority-");
  const source = path.join(directory, "source");
  const target = path.join(directory, "target");
  const retained = path.join(directory, "retained");
  await fs.writeFile(source, "original");
  const original = await fs.lstat(source, { bigint: true });
  const directories = new Map<number, string>();
  const renameNoReplace = vi.fn((sourceFd: number, sourceName: string, targetFd: number, targetName: string) => {
    const targetPath = path.join(directories.get(targetFd)!, targetName);
    if (fsSync.existsSync(targetPath)) throw Object.assign(new Error("destination exists"), { code: "EEXIST" });
    fsSync.renameSync(path.join(directories.get(sourceFd)!, sourceName), targetPath);
  });
  __setNativeLoaderForTest(() => ({
    openBeneath: (_fd: number, relative: string, flags: number) => {
      const parent = path.join(directory, relative);
      const fd = fsSync.openSync(parent, flags);
      directories.set(fd, parent);
      return { fd, containment: "best-effort" as const };
    },
    renameNoReplace,
    closeOwnedFd: (fd: number) => fsSync.closeSync(fd),
  }) as NativeBinding);
  configureFsSafeNative({ mode: "require" });
  return { source, target, retained, original, renameNoReplace, scoped: await root(directory) };
}

it.each([
  { change: "hardlink", code: "hardlink" },
  { change: "directory", code: "invalid-path" },
  { change: "replacement", code: "path-mismatch" },
] as const)("rejects a source $change introduced by the final authority callback", async ({ change, code }) => {
  const f = await fixture();
  let replacement: fsSync.BigIntStats | undefined;
  const assertBeforeMutation = vi.fn(() => {
    if (change === "hardlink") {
      fsSync.linkSync(f.source, f.retained);
    } else {
      fsSync.renameSync(f.source, f.retained);
      if (change === "directory") fsSync.mkdirSync(f.source);
      else fsSync.writeFileSync(f.source, "replacement");
    }
    replacement = fsSync.lstatSync(f.source, { bigint: true });
  });
  const outcome = await f.scoped.move("source", "target", { assertBeforeMutation }).then(
    () => ({ resolved: true }),
    error => ({ error }),
  );

  expect.soft(outcome).toMatchObject({ error: { code } });
  expect.soft(assertBeforeMutation).toHaveBeenCalledOnce();
  expect.soft(f.renameNoReplace).not.toHaveBeenCalled();
  expect(await fs.lstat(f.retained, { bigint: true })).toMatchObject({ dev: f.original.dev, ino: f.original.ino });
  expect(await fs.readFile(f.retained, "utf8")).toBe("original");
  await expect.soft(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.lstat(f.source, { bigint: true })).toMatchObject({ dev: replacement!.dev, ino: replacement!.ino });
  if (change === "hardlink") expect((await fs.stat(f.source)).nlink).toBe(2);
  else if (change === "directory") expect((await fs.stat(f.source)).isDirectory()).toBe(true);
  else expect(await fs.readFile(f.source, "utf8")).toBe("replacement");
});

it.each(["dev", "ino"] as const)("compares exact source %s after authority", async field => {
  const f = await fixture();
  const original = 9007199254740992n;
  const replacement = original + 1n;
  expect(Number(original)).toBe(Number(replacement));
  let changed = false;
  const lstat = fsSync.lstatSync.bind(fsSync);
  // Only source identity is projected; directory guards and filesystem I/O stay real.
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
    const actual = lstat(...args);
    if (String(args[0]) !== f.source) return actual;
    const value = changed ? replacement : original;
    return Object.assign(Object.create(actual), { [field]: typeof actual[field] === "bigint" ? value : Number(value) });
  }) as typeof fsSync.lstatSync);

  await expect(f.scoped.move("source", "target", {
    assertBeforeMutation: () => { changed = true; },
  })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(changed).toBe(true);
  expect(f.renameNoReplace).not.toHaveBeenCalled();
  expect(await fs.readFile(f.source, "utf8")).toBe("original");
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each((["dev", "ino"] as const).flatMap(field =>
  (["no-callback", "before-callback", "after-callback"] as const).map(phase => ({ field, phase })),
))("handles unknown Windows source $field with $phase", async ({ field, phase }) => {
  const f = await fixture();
  let unknown = false;
  const lstat = fsSync.lstatSync.bind(fsSync);
  // Project Windows source metadata after native parent admission; I/O and guards stay real.
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
    const actual = lstat(...args);
    if (!unknown || String(args[0]) !== f.source) return actual;
    return Object.assign(Object.create(actual), { [field]: typeof actual[field] === "bigint" ? 0n : 0 });
  }) as typeof fsSync.lstatSync);
  __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    unknown = phase !== "after-callback";
  } });
  const assertBeforeMutation = vi.fn(() => { unknown = true; });
  const moving = f.scoped.move("source", "target", phase === "no-callback" ? {} : { assertBeforeMutation });
  if (phase === "no-callback") {
    await moving;
    expect(f.renameNoReplace).toHaveBeenCalledOnce();
    expect(await fs.lstat(f.target, { bigint: true })).toMatchObject({ dev: f.original.dev, ino: f.original.ino });
    expect(await fs.readFile(f.target, "utf8")).toBe("original");
    await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
  } else {
    await expect(moving).rejects.toMatchObject({ code: "path-mismatch" });
    expect(f.renameNoReplace).not.toHaveBeenCalled();
    expect(await fs.readFile(f.source, "utf8")).toBe("original");
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(assertBeforeMutation).toHaveBeenCalledTimes(phase === "after-callback" ? 1 : 0);
});

it.each(["admission", "authority"] as const)("normalizes a source removed during %s", async phase => {
  const f = await fixture();
  const lstat = fsSync.lstatSync.bind(fsSync);
  let observedFailure: unknown;
  vi.spyOn(fsSync, "lstatSync").mockImplementation(((...args: Parameters<typeof fsSync.lstatSync>) => {
    try {
      return lstat(...args);
    } catch (error) {
      if (String(args[0]) === f.source) observedFailure = error;
      throw error;
    }
  }) as typeof fsSync.lstatSync);
  if (phase === "admission") {
    __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: () => { fsSync.unlinkSync(f.source); } });
  }
  const assertBeforeMutation = vi.fn(() => { fsSync.unlinkSync(f.source); });
  const error = await f.scoped.move("source", "target", { assertBeforeMutation }).catch(error => error);

  expect(error).toBeInstanceOf(FsSafeError);
  expect(error).toMatchObject({ code: "not-found", message: "file not found" });
  expect(observedFailure).toBeInstanceOf(Error);
  expect(error.cause).toBe(observedFailure);
  expect(error.cause).toMatchObject({ code: "ENOENT", syscall: "lstat", path: f.source });
  expect(assertBeforeMutation).toHaveBeenCalledTimes(phase === "admission" ? 0 : 1);
  expect(f.renameNoReplace).not.toHaveBeenCalled();
  await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([undefined, null, false, 0, "", { code: "ENOENT" }])(
  "preserves an arbitrary authority rejection: %j", async rejection => {
    const f = await fixture();
    const assertBeforeMutation = vi.fn(() => { throw rejection; });
    const outcome = await f.scoped.move("source", "target", { assertBeforeMutation }).then(
      () => ({ resolved: true }),
      error => ({ error }),
    );
    expect(outcome).toEqual({ error: rejection });
    expect(assertBeforeMutation).toHaveBeenCalledOnce();
    expect(f.renameNoReplace).not.toHaveBeenCalled();
    expect(await fs.lstat(f.source, { bigint: true })).toMatchObject({ dev: f.original.dev, ino: f.original.ino });
    await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
