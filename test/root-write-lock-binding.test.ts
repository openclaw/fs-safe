import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as pinnedWrite from "../src/pinned-write.js";
import { withRootFallbackCompatibilityLock } from "../src/root-write-compatibility.js";
import { canReuseParentWithMutationAssertion } from "../src/root-write-lock-binding.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => vi.restoreAllMocks());

it("keeps the portable lock key and a native writer route", async () => {
  const directory = await tempRoot("fs-safe-binding-route-");
  const target = path.join(directory, "nested", "target");
  const acquire = vi.spyOn(pinnedWrite, "withPinnedWriteRenameIdentityLock")
    .mockImplementation(async (_params, run) => await run());
  let retained: (() => void) | undefined;
  await withRootFallbackCompatibilityLock({ rootPath: directory, targetPath: target }, async binding => {
    expect(binding.relativePath).toBe(path.join("nested", "target"));
    expect(acquire).toHaveBeenCalledWith({
      rootPath: directory, targetPath: target, relativeTargetPath: "nested/target",
    }, expect.any(Function));
    expect(canReuseParentWithMutationAssertion(binding.assertBeforeMutation, directory, target)).toBe(true);
    expect(canReuseParentWithMutationAssertion(() => binding.assertBeforeMutation(), directory, target)).toBe(false);
    expect(canReuseParentWithMutationAssertion(binding.assertBeforeMutation.bind(undefined), directory, target)).toBe(false);
    expect(canReuseParentWithMutationAssertion(binding.assertBeforeMutation, directory, `${target}-other`)).toBe(false);
    expect(canReuseParentWithMutationAssertion(binding.assertBeforeMutation, `${directory}-other`, target)).toBe(false);
    binding.assertBeforeMutation();
    retained = binding.assertBeforeMutation;
  });
  expect(canReuseParentWithMutationAssertion(retained, directory, target)).toBe(false);
  expect(retained).toThrow(/expired/);
  await expect(fs.readdir(directory)).resolves.toEqual([]);
});

it("never marks a caller callback as an internal observation", async () => {
  const directory = await tempRoot("fs-safe-binding-callback-");
  const target = path.join(directory, "target");
  vi.spyOn(pinnedWrite, "withPinnedWriteRenameIdentityLock")
    .mockImplementation(async (_params, run) => await run());
  const sentinel = new Error("caller revoked");
  const callback = Object.assign(vi.fn(() => { throw sentinel; }), { observationOnly: true });
  const params = { rootPath: directory, targetPath: target, assertBeforeMutation: callback };
  expect(canReuseParentWithMutationAssertion(callback, directory, target)).toBe(false);
  await withRootFallbackCompatibilityLock(params, async binding => {
    expect(canReuseParentWithMutationAssertion(binding.assertBeforeMutation, directory, target)).toBe(false);
    expect(() => binding.assertBeforeMutation()).toThrow(sentinel);
    expect(callback.mock.contexts).toEqual([params]);
  });
  expect(callback).toHaveBeenCalledTimes(1);
  await expect(fs.readdir(directory)).resolves.toEqual([]);
});

it("expires the internal observation when the locked operation rejects", async () => {
  const directory = await tempRoot("fs-safe-binding-failure-");
  const target = path.join(directory, "target");
  vi.spyOn(pinnedWrite, "withPinnedWriteRenameIdentityLock")
    .mockImplementation(async (_params, run) => await run());
  const sentinel = new Error("write rejected");
  let retained: (() => void) | undefined;

  await expect(withRootFallbackCompatibilityLock({ rootPath: directory, targetPath: target }, async binding => {
    retained = binding.assertBeforeMutation;
    expect(canReuseParentWithMutationAssertion(retained, directory, target)).toBe(true);
    throw sentinel;
  })).rejects.toBe(sentinel);

  expect(retained).toBeTypeOf("function");
  expect(canReuseParentWithMutationAssertion(retained, directory, target)).toBe(false);
  expect(retained).toThrow(/expired/);
  await expect(fs.readdir(directory)).resolves.toEqual([]);
});

it("keeps active observations isolated by target and lock lifetime", async () => {
  const directory = await tempRoot("fs-safe-binding-isolation-");
  const firstTarget = path.join(directory, "first");
  const secondTarget = path.join(directory, "second");
  vi.spyOn(pinnedWrite, "withPinnedWriteRenameIdentityLock")
    .mockImplementation(async (_params, run) => await run());
  let secondAssertion: (() => void) | undefined;

  await withRootFallbackCompatibilityLock({ rootPath: directory, targetPath: firstTarget }, async first => {
    await withRootFallbackCompatibilityLock({ rootPath: directory, targetPath: secondTarget }, async second => {
      secondAssertion = second.assertBeforeMutation;
      expect(canReuseParentWithMutationAssertion(first.assertBeforeMutation, directory, firstTarget)).toBe(true);
      expect(canReuseParentWithMutationAssertion(first.assertBeforeMutation, directory, secondTarget)).toBe(false);
      expect(canReuseParentWithMutationAssertion(secondAssertion, directory, secondTarget)).toBe(true);
      expect(canReuseParentWithMutationAssertion(secondAssertion, directory, firstTarget)).toBe(false);
    });
    expect(canReuseParentWithMutationAssertion(first.assertBeforeMutation, directory, firstTarget)).toBe(true);
    expect(canReuseParentWithMutationAssertion(secondAssertion, directory, secondTarget)).toBe(false);
    first.assertBeforeMutation();
    expect(secondAssertion).toThrow(/expired/);
  });
  await expect(fs.readdir(directory)).resolves.toEqual([]);
});
