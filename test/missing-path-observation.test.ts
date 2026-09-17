import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { observeMutationPath } from "../src/pinned-mutation-observation.js";
import { resolvePathViaExistingAncestor } from "../src/root-path-existing.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it("observes missing paths without constructing routine lstat exceptions", async () => {
  const directory = await tempRoot("fs-safe-missing-probe-");
  const target = path.join(directory, "one", "two", "value");
  const lstat = fs.lstatSync.bind(fs);
  let missingExceptions = 0;
  vi.spyOn(fs, "lstatSync").mockImplementation(((name, options) => {
    try { return lstat(name, options); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missingExceptions += 1;
      throw error;
    }
  }) as typeof fs.lstatSync);

  expect(observeMutationPath(target)).toMatchObject({ ancestor: directory });
  await expect(resolvePathViaExistingAncestor(target)).resolves.toBe(target);
  expect(missingExceptions).toBe(0);
});

it("keeps non-directory and permission failures distinct from missing evidence", async () => {
  const directory = await tempRoot("fs-safe-missing-classification-");
  const file = path.join(directory, "file");
  fs.writeFileSync(file, "ordinary file");
  const nonDirectory = path.join(file, "child");
  expect(observeMutationPath(nonDirectory)).toBeUndefined();
  await expect(resolvePathViaExistingAncestor(nonDirectory)).resolves.toBe(nonDirectory);

  const denied = path.join(directory, "denied");
  const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const lstat = fs.lstatSync.bind(fs);
  vi.spyOn(fs, "lstatSync").mockImplementation(((name, options) => {
    if (name === denied) throw failure;
    return lstat(name, options);
  }) as typeof fs.lstatSync);
  expect(observeMutationPath(denied)).toBeUndefined();
  await expect(resolvePathViaExistingAncestor(denied)).rejects.toBe(failure);
});

it("retains missing-path handling when a runtime still throws ENOENT", async () => {
  const directory = await tempRoot("fs-safe-missing-throwing-runtime-");
  const target = path.join(directory, "missing", "value");
  const lstat = fs.lstatSync.bind(fs);
  vi.spyOn(fs, "lstatSync").mockImplementation(((name, options) =>
    lstat(name, { ...options, throwIfNoEntry: true })) as typeof fs.lstatSync);

  expect(observeMutationPath(target)).toMatchObject({ ancestor: directory });
  await expect(resolvePathViaExistingAncestor(target)).resolves.toBe(target);
});
