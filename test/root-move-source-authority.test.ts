import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest } from "../src/native.js";
import { FsSafeError } from "../src/errors.js";
import { root, type DenyMutationPolicy } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { noReplaceAdapter } from "./helpers/no-replace-adapter.js";
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

async function fixture(layout: "flat" | "separate-parents") {
  const directory = await tempRoot("fs-safe-native-move-authority-");
  const source = path.join(directory, layout === "flat" ? "source" : "incoming/source");
  const target = path.join(directory, layout === "flat" ? "target" : "archive/target");
  const retained = path.join(directory, "retained");
  if (layout === "separate-parents") {
    await Promise.all([fs.mkdir(path.dirname(source)), fs.mkdir(path.dirname(target))]);
  }
  await fs.writeFile(source, "original");
  const original = await fs.lstat(source, { bigint: true });
  const { binding, renameNoReplace } = noReplaceAdapter(directory);
  __setNativeLoaderForTest(() => binding);
  configureFsSafeNative({ mode: "require" });
  return { directory, source, target, retained, original, renameNoReplace };
}

it.each([
  { change: "hardlink", code: "hardlink" },
  { change: "directory", code: "invalid-path" },
  { change: "replacement", code: "path-mismatch" },
] as const)("rejects a source $change introduced by the final authority callback", async ({ change, code }) => {
  const f = await fixture("flat");
  const scoped = await root(f.directory);
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
  const outcome = await scoped.move("source", "target", { assertBeforeMutation }).then(
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
  const f = await fixture("flat");
  const scoped = await root(f.directory);
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

  await expect(scoped.move("source", "target", {
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
  const f = await fixture("flat");
  const scoped = await root(f.directory);
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
  const moving = scoped.move("source", "target", phase === "no-callback" ? {} : { assertBeforeMutation });
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
  const f = await fixture("flat");
  const scoped = await root(f.directory);
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
  const error = await scoped.move("source", "target", { assertBeforeMutation }).catch(error => error);

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
    const f = await fixture("flat");
    const scoped = await root(f.directory);
    const assertBeforeMutation = vi.fn(() => { throw rejection; });
    const outcome = await scoped.move("source", "target", { assertBeforeMutation }).then(
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

it.each(
  (["default", "per-call"] as const).flatMap(scope =>
    (["paths", "prefixes"] as const).flatMap(field =>
      (["source", "target"] as const).map(boundary => ({ scope, field, boundary })),
    ),
  ),
)("snapshots $scope $field denying the $boundary before the first await", async ({ scope, field, boundary }) => {
  const f = await fixture("separate-parents");
  const entries = [field === "paths" ? f[boundary] : path.dirname(f[boundary])];
  const denyMutations: DenyMutationPolicy = { [field]: entries };
  const assertBeforeMutation = vi.fn();
  const scoped = await root(f.directory, {
    denyMutations: scope === "default" ? denyMutations : undefined,
  });
  const options = {
    denyMutations: scope === "per-call" ? denyMutations : undefined,
    assertBeforeMutation,
  };

  const pending = scoped.move("incoming/source", "archive/target", options);
  entries.length = 0;
  await expect(pending).rejects.toMatchObject({ code: "denied-path" });

  expect(assertBeforeMutation).not.toHaveBeenCalled();
  expect(f.renameNoReplace).not.toHaveBeenCalled();
  expect(await fs.lstat(f.source, { bigint: true })).toMatchObject({
    dev: f.original.dev,
    ino: f.original.ino,
  });
  expect(await fs.readFile(f.source, "utf8")).toBe("original");
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });

  await scoped.move("incoming/source", "archive/target", options);

  expect(assertBeforeMutation).toHaveBeenCalledOnce();
  expect(f.renameNoReplace).toHaveBeenCalledOnce();
  expect(await fs.lstat(f.target, { bigint: true })).toMatchObject({
    dev: f.original.dev,
    ino: f.original.ino,
  });
  expect(await fs.readFile(f.target, "utf8")).toBe("original");
  await expect(fs.lstat(f.source)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves live authority revocation after native parent admission", async () => {
  const f = await fixture("separate-parents");
  const rejection = Object.assign(new Error("lease expired"), { code: "ENOENT" });
  let leaseExpired = false;
  const defaultAssertion = vi.fn();
  const callAssertion = vi.fn(() => {
    if (leaseExpired) throw rejection;
  });
  const scoped = await root(f.directory, {
    denyMutations: { paths: [path.join(f.directory, "protected")] },
    assertBeforeMutation: defaultAssertion,
  });
  const afterAdmission = vi.fn((operation: string, targetPath: string) => {
    expect(operation).toBe("move");
    expect(targetPath).toBe(f.target);
    leaseExpired = true;
  });
  __setFsSafeTestHooksForTest({ beforeRootFallbackMutation: afterAdmission });

  await expect(scoped.move("incoming/source", "archive/target", {
    assertBeforeMutation: callAssertion,
  })).rejects.toBe(rejection);

  expect(afterAdmission).toHaveBeenCalledOnce();
  expect(leaseExpired).toBe(true);
  expect(defaultAssertion).toHaveBeenCalledOnce();
  expect(callAssertion).toHaveBeenCalledOnce();
  expect(f.renameNoReplace).not.toHaveBeenCalled();
  expect(await fs.lstat(f.source, { bigint: true })).toMatchObject({
    dev: f.original.dev,
    ino: f.original.ino,
  });
  expect(await fs.readFile(f.source, "utf8")).toBe("original");
  await expect(fs.lstat(f.target)).rejects.toMatchObject({ code: "ENOENT" });
});
