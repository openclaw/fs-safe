import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest, __setNativeLoaderForTest, type NativeBinding } from "../src/native.js";
import { root, type DenyMutationPolicy } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __resetFsSafeNativeConfigForTest();
  __resetNativeLoaderForTest();
  __setFsSafeTestHooksForTest();
});

async function fixture() {
  const directory = await tempRoot("fs-safe-root-move-policy-snapshot-");
  const source = path.join(directory, "incoming", "source");
  const target = path.join(directory, "archive", "target");
  await Promise.all([fs.mkdir(path.dirname(source)), fs.mkdir(path.dirname(target))]);
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
  return { directory, source, target, original, renameNoReplace };
}

it.each(
  (["default", "per-call"] as const).flatMap(scope =>
    (["paths", "prefixes"] as const).flatMap(field =>
      (["source", "target"] as const).map(boundary => ({ scope, field, boundary })),
    ),
  ),
)("snapshots $scope $field denying the $boundary before the first await", async ({ scope, field, boundary }) => {
  const f = await fixture();
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
  const f = await fixture();
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
