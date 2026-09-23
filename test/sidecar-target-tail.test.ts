import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { realpathSync } from "../src/realpath.js";
import { root } from "../src/root.js";
import { resolveSidecarTargetPath } from "../src/sidecar-lock-target.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it("retains the second Root fence after canonicalizing an external arbitration key", async () => {
  const directory = await tempRoot("fs-safe-sidecar-target-fence-");
  const lockDirectory = path.join(directory, "locks");
  const targetParent = path.join(directory, "external");
  await fs.mkdir(lockDirectory);
  await fs.mkdir(targetParent);
  const capability = await root(lockDirectory);
  const target = path.join(targetParent, "missing", "key");
  const sentinel = new Error("second Root fence failed");
  let canonicalized = false;
  const canonicalize = realpathSync.native;
  vi.spyOn(realpathSync, "native").mockImplementation((pathname) => {
    const result = canonicalize(pathname);
    if (pathname === targetParent) canonicalized = true;
    return result;
  });
  const resolve = capability.resolve.bind(capability);
  const fences = vi.spyOn(capability, "resolve").mockImplementationOnce(resolve).mockImplementationOnce(async () => {
    expect(canonicalized).toBe(true);
    throw sentinel;
  });
  const mkdir = vi.spyOn(fs, "mkdir");
  await expect(resolveSidecarTargetPath(target, capability)).rejects.toBe(sentinel);
  expect(fences.mock.calls).toEqual([["."], ["."]]);
  expect(mkdir).not.toHaveBeenCalled();
  await expect(fs.lstat(path.dirname(target))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["mkdir", "realpath"])("keeps the unbounded %s failure in its original error domain", async (operation) => {
  const directory = await tempRoot("fs-safe-sidecar-target-fallback-");
  const parent = path.join(directory, "parent");
  const target = path.join(parent, "key");
  const sentinel = new Error("target preparation failed");
  const mkdir = vi.spyOn(fs, "mkdir");
  const realpath = vi.spyOn(realpathSync, "native");
  if (operation === "mkdir") mkdir.mockRejectedValueOnce(sentinel);
  else realpath.mockImplementationOnce(() => { throw sentinel; });
  const result = resolveSidecarTargetPath(target);
  if (operation === "mkdir") await expect(result).rejects.toBe(sentinel);
  else await expect(result).resolves.toBe(target);
  expect(mkdir).toHaveBeenCalledOnce();
  expect(realpath).toHaveBeenCalledTimes(operation === "realpath" ? 1 : 0);
});
