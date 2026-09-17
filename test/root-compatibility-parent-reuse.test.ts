import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { __resetNativeLoaderForTest } from "../src/native.js";
import * as context from "../src/root-context.js";
import { root } from "../src/root.js";
import { withRootFallbackCompatibilityLock } from "../src/root-write-compatibility.js";
import { prepareSharedRootWriteTarget } from "../src/root-write-complete-parent.js";
import {
  assertRootWritePathSelectionSync,
  prepareGuardedRootWritePathSelection,
  resolveGuardedWriteTargetInRoot,
} from "../src/root-write-admission.js";
import { canReuseParentWithMutationAssertion } from "../src/root-write-lock-binding.js";
import { observeMutationAuthorizations } from "./helpers/root-shared-js-admission.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); __resetFsSafeNativeConfigForTest(); __resetNativeLoaderForTest(); });

type CompatibilityBinding = Parameters<Parameters<typeof withRootFallbackCompatibilityLock>[1]>[0];

async function prepareLockedTarget(
  rootContext: context.RootContext,
  binding: CompatibilityBinding,
  denied: string,
  reusable = true,
) {
  expect(canReuseParentWithMutationAssertion(
    binding.assertBeforeMutation, rootContext.rootReal, binding.targetPath,
  )).toBe(reusable);
  const guardedTarget = await resolveGuardedWriteTargetInRoot(rootContext, {
    relativePath: binding.relativePath,
    denyMutations: { prefixes: [denied] },
    mutationSymlinks: "reject",
  });
  const prepared = await prepareSharedRootWriteTarget(rootContext, {
    relativePath: binding.relativePath, guardedTarget,
    assertBeforeMutation: binding.assertBeforeMutation,
  });
  const selection = await prepareGuardedRootWritePathSelection(
    guardedTarget, prepared.targetPath, prepared.targetPath, prepared.preparedParent,
  );
  expect(selection).toBeDefined();
  binding.assertBeforeMutation();
  assertRootWritePathSelectionSync(rootContext, selection!);
  return prepared;
}

it.skipIf(process.platform !== "win32" || Boolean(process.versions.bun)).each([
  { operation: "create", missing: false }, { operation: "create", missing: true },
  { operation: "exclusive", missing: false }, { operation: "exclusive", missing: true },
  { operation: "overwrite", missing: false }, { operation: "overwrite", missing: true },
] as const)("retains bounded $operation lock admission (missing=$missing)", async ({ operation, missing }) => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-compat-reuse-");
  const safe = await root(directory);
  const denied = path.join(safe.rootReal, "denied");
  await fs.mkdir(denied);
  let advances = 0;
  observeMutationAuthorizations({ afterSharedAdvance(advanced) { if (advanced) advances += 1; } });
  const resolve = vi.spyOn(context, "resolvePathInRoot");
  const counts: number[] = [];
  for (const depth of [1, 8, 32]) {
    const parent = path.join(safe.rootReal, `depth-${depth}`, ...Array.from({ length: depth - 1 }, (_, i) => `d${i}`));
    const target = path.join(parent, "value");
    if (!missing) await fs.mkdir(parent, { recursive: true });
    if (!missing && operation === "overwrite") await fs.writeFile(target, "old");
    const relative = path.relative(safe.rootReal, target);
    const options = {
      denyMutations: { prefixes: [denied] }, mutationSymlinks: "reject" as const,
      renameIdentity: "verify-content-with-lock" as const, durable: false,
    };
    resolve.mockClear();
    if (operation === "create") await safe.create(relative, Buffer.from("payload"), options);
    else await safe.write(relative, Buffer.from("payload"), { ...options, overwrite: operation !== "exclusive" });
    counts.push(resolve.mock.calls.filter(([, requested]) => requested === relative).length);
    expect(await fs.readFile(target, "utf8")).toBe("payload");
    expect(await fs.readdir(parent)).toEqual(["value"]);
  }
  expect(counts[0]).toBeGreaterThan(0);
  expect(new Set(counts).size).toBe(1);
  expect(advances).toBe(missing ? 41 : 0);
  expect((await fs.readdir(safe.rootReal)).sort()).toEqual(["denied", "depth-1", "depth-32", "depth-8"]);
});

it.skipIf(Boolean(process.versions.bun))("rejects parent replacement after reused authorization and before locked mkdir", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-compat-reuse-swap-");
  const rootContext = await context.resolveRootContext(directory);
  const identity = await fs.lstat(rootContext.rootReal, { bigint: true });
  const parent = path.join(rootContext.rootReal, "parent");
  const saved = path.join(rootContext.rootReal, "saved");
  const denied = path.join(rootContext.rootReal, "denied");
  await fs.mkdir(parent); await fs.mkdir(denied);
  await fs.writeFile(path.join(parent, "keep"), "original");
  let swapped = false;
  observeMutationAuthorizations({ afterSharedProbe(request, reused) {
    if (swapped || !reused || request.phase !== "parent-create") return;
    swapped = true;
    fsSync.renameSync(parent, saved);
    fsSync.mkdirSync(parent);
  } });
  await expect(withRootFallbackCompatibilityLock({
    rootPath: rootContext.rootReal, rootIdentity: { dev: identity.dev, ino: identity.ino },
    targetPath: path.join(parent, "new", "value"),
  }, async binding => {
    await prepareLockedTarget(rootContext, binding, denied);
  })).rejects.toMatchObject({ code: "path-mismatch" });
  expect(swapped).toBe(true);
  expect(await fs.readdir(parent)).toEqual([]);
  expect(await fs.readdir(saved)).toEqual(["keep"]);
  expect(await fs.readFile(path.join(saved, "keep"), "utf8")).toBe("original");
});

it.skipIf(Boolean(process.versions.bun)).each([false, true])(
  "reuses shared parent evidence with a library lock observation (missing=%s)", async missing => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-compat-shared-");
    const rootContext = await context.resolveRootContext(directory);
    const identity = await fs.lstat(rootContext.rootReal, { bigint: true });
    const denied = path.join(rootContext.rootReal, "denied");
    await fs.mkdir(denied);
    let advances = 0;
    observeMutationAuthorizations({ afterSharedAdvance(advanced) { if (advanced) advances += 1; } });
    const resolve = vi.spyOn(context, "resolvePathInRoot");
    const counts: number[] = [];
    for (const depth of [1, 8, 32]) {
      const parent = path.join(rootContext.rootReal, `depth-${depth}`, ...Array.from({ length: depth - 1 }, (_, i) => `d${i}`));
      const target = path.join(parent, "value");
      if (!missing) await fs.mkdir(parent, { recursive: true });
      await withRootFallbackCompatibilityLock({
        rootPath: rootContext.rootReal, rootIdentity: { dev: identity.dev, ino: identity.ino }, targetPath: target,
      }, async binding => {
        resolve.mockClear();
        const prepared = await prepareLockedTarget(rootContext, binding, denied);
        expect(prepared.targetPath).toBe(target);
        expect(prepared.preparedParent === undefined).toBe(missing);
        counts.push(resolve.mock.calls.filter(([, requested]) => requested === binding.relativePath).length);
      });
      expect((await fs.lstat(parent)).isDirectory()).toBe(true);
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(new Set(counts).size).toBe(1);
    expect(advances).toBe(missing ? 41 : 0);
  },
);

it.skipIf(Boolean(process.versions.bun))("keeps user revocation ahead of locked parent creation", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-compat-user-authority-");
  const rootContext = await context.resolveRootContext(directory);
  const identity = await fs.lstat(rootContext.rootReal, { bigint: true });
  const denied = path.join(rootContext.rootReal, "denied");
  await fs.mkdir(denied);
  const revoked = new Error("user authority revoked");
  let checks = 0;
  let advances = 0;
  observeMutationAuthorizations({ afterSharedAdvance(advanced) { if (advanced) advances += 1; } });

  await expect(withRootFallbackCompatibilityLock({
    rootPath: rootContext.rootReal,
    rootIdentity: { dev: identity.dev, ino: identity.ino },
    targetPath: path.join(rootContext.rootReal, "one", "two", "value"),
    assertBeforeMutation() {
      if (++checks === 2) throw revoked;
    },
  }, async binding => {
    await prepareLockedTarget(rootContext, binding, denied, false);
  })).rejects.toBe(revoked);

  expect(checks).toBe(2);
  expect(advances).toBe(0);
  expect(await fs.readdir(path.join(rootContext.rootReal, "one"))).toEqual([]);
  expect((await fs.readdir(rootContext.rootReal)).sort()).toEqual(["denied", "one"]);
});

it.skipIf(Boolean(process.versions.bun))("treats a library validator passed through public options as user authority", async () => {
  configureFsSafeNative({ mode: "off" });
  const directory = await tempRoot("fs-safe-compat-public-assertion-");
  const safe = await root(directory);
  const identity = await fs.lstat(safe.rootReal, { bigint: true });
  const denied = path.join(safe.rootReal, "denied");
  await fs.mkdir(denied);
  let advances = 0;
  observeMutationAuthorizations({ afterSharedAdvance(advanced) { if (advanced) advances += 1; } });
  const resolve = vi.spyOn(context, "resolvePathInRoot");
  const counts: number[] = [];
  for (const depth of [1, 8]) {
    const parent = path.join(safe.rootReal, `depth-${depth}`, ...Array.from({ length: depth - 1 }, (_, i) => `d${i}`));
    await fs.mkdir(parent, { recursive: true });
    await withRootFallbackCompatibilityLock({
      rootPath: safe.rootReal, rootIdentity: { dev: identity.dev, ino: identity.ino },
      targetPath: path.join(parent, "value"),
    }, async binding => {
      resolve.mockClear();
      const opened = await safe.openWritable(binding.relativePath, {
        writeMode: "update", denyMutations: { prefixes: [denied] }, mutationSymlinks: "reject",
        assertBeforeMutation: binding.assertBeforeMutation,
      });
      try {
        counts.push(resolve.mock.calls.filter(([, requested]) => requested === binding.relativePath).length);
      } finally {
        await opened.handle.close();
      }
    });
  }
  expect(counts[0]).toBeGreaterThan(0);
  expect(counts[1]).toBeGreaterThan(counts[0]!);
  expect(advances).toBe(0);
});
