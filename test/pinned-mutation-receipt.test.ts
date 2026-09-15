import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMutationNotDenied, type DenyMutationPolicy } from "../src/deny-mutations.js";
import { FsSafeError } from "../src/errors.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import * as native from "../src/native.js";
import { preparePinnedWriteMutationAdmission, snapshotPinnedMutationPolicy } from "../src/pinned-mutation-admission.js";
import { resolvePathInRoot, resolveRootContext } from "../src/root-context.js";
import type { MutationSymlinkPolicy } from "../src/root-symlink-policy.js";
import { mutationSymlinkResolution } from "../src/root-symlink-policy.js";
import { realpathSync } from "../src/realpath.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetFsSafeNativeConfigForTest();
});

async function prepare(directory: string, originalPath: string, denyMutations?: DenyMutationPolicy,
  mutationSymlinks: MutationSymlinkPolicy = "reject", beginParentWalk = true) {
  const context = await resolveRootContext(directory);
  const policy = snapshotPinnedMutationPolicy(denyMutations, mutationSymlinks)!;
  const resolveCurrent = vi.fn(async () => {
    const current = await resolvePathInRoot(context, originalPath, {
      aliasErrorCode: "path-alias", rejectAmbiguousParents: true,
      ...mutationSymlinkResolution(mutationSymlinks),
    });
    await assertMutationNotDenied(current.resolved, policy.denyMutations);
    return current;
  });
  const initial = await resolveCurrent();
  const { mutationAdmission: admission } = await preparePinnedWriteMutationAdmission({
    ...context, originalPath, resolvedTargetPath: initial.resolved,
    defaultRelativeParentPath: path.dirname(originalPath), policy, resolveCurrent,
  });
  if (beginParentWalk) admission?.beginParentWalk?.();
  resolveCurrent.mockClear();
  return {
    admission: admission!, resolveCurrent, target: initial.resolved,
    authorize: (mutationPath = initial.resolved) => admission!.authorize(Object.freeze({
      targetPath: initial.resolved, mutationPath,
      phase: mutationPath === initial.resolved ? "parent" : "parent-create",
    })),
  };
}

function directoryObservation(pathname: string) {
  const stat = fsSync.lstatSync(pathname, { bigint: true });
  return Object.freeze({ path: pathname, realPath: fsSync.realpathSync.native(pathname), dev: stat.dev, ino: stat.ino });
}

describe.runIf(process.platform !== "win32" && !process.versions.bun)("operation-local mutation receipts", () => {
  it("does not capture an unused receipt before a parent walk is requested", async () => {
    const directory = await tempRoot("fs-safe-policy-receipt-opt-in-");
    await fs.mkdir(path.join(directory, "parent"));
    const receipt = await prepare(directory, "parent/value", undefined, "reject", false);
    await receipt.authorize();
    await receipt.authorize();
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(2);
    receipt.admission.beginParentWalk?.();
    await receipt.authorize();
    await receipt.authorize();
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(3);
  });

  it("reuses one admission through a verified direct-child walk and final parent admission", async () => {
    const directory = await tempRoot("fs-safe-policy-receipt-depth-");
    const parts = Array.from({ length: 24 }, (_, index) => `level-${index}`);
    const receipt = await prepare(directory, [...parts, "value"].join("/"), {
      paths: [path.join(directory, "unrelated", "missing", "record")],
      prefixes: [path.join(directory, "unrelated", "protected")],
    });
    let parent = directory;
    for (const part of parts) {
      const child = path.join(parent, part);
      const parentEvidence = directoryObservation(parent);
      await receipt.authorize(child);
      await fs.mkdir(child);
      receipt.admission.advanceCreatedDirectory!(parentEvidence, directoryObservation(child));
      await receipt.authorize();
      parent = child;
    }
    await receipt.authorize();
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(1);
  });

  it.each(["rebind", "missing appearance"])("refreshes all denied paths after %s", async (change) => {
    const directory = await tempRoot("fs-safe-policy-receipt-deny-");
    const allowed = path.join(directory, "allowed");
    const unrelated = path.join(directory, "unrelated");
    const denied = path.join(directory, "deny-route");
    await fs.mkdir(allowed);
    await fs.mkdir(unrelated);
    if (change === "rebind") await fs.symlink(unrelated, denied, "dir");
    const receipt = await prepare(directory, "allowed/nested/value", { prefixes: [denied] });
    await receipt.authorize();
    if (change === "rebind") await fs.unlink(denied);
    await fs.symlink(allowed, denied, "dir");
    await expect(receipt.authorize(path.join(allowed, "nested"))).rejects.toMatchObject({ code: "denied-path" });
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(2);
    await expect(fs.lstat(path.join(allowed, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks the original route before the actual-parent deny and target-mismatch errors", async () => {
    const directory = await tempRoot("fs-safe-policy-receipt-order-");
    const allowed = path.join(directory, "allowed");
    const denied = path.join(directory, "denied");
    await fs.mkdir(allowed);
    await fs.mkdir(denied);
    const receipt = await prepare(directory, "allowed/nested/value", { prefixes: [denied] });
    await receipt.authorize();
    await fs.rename(allowed, path.join(directory, "saved"));
    await fs.symlink(denied, allowed, "dir");
    await expect(receipt.admission.authorize({
      targetPath: path.join(denied, "nested/value"), mutationPath: denied, phase: "parent-create",
    })).rejects.toMatchObject({ code: "symlink" });
  });

  it("never treats an unexpected deeper child as a directory created by the walk", async () => {
    const directory = await tempRoot("fs-safe-policy-receipt-unexpected-");
    const receipt = await prepare(directory, "one/two/three/value");
    const parentEvidence = directoryObservation(directory);
    const first = path.join(directory, "one");
    await receipt.authorize(first);
    await fs.mkdir(path.join(first, "two"), { recursive: true });
    receipt.admission.advanceCreatedDirectory!(parentEvidence, directoryObservation(first));
    await receipt.authorize();
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(2);
  });

  it("refreshes when a parent is replaced before a claimed child advance", async () => {
    const directory = await tempRoot("fs-safe-policy-receipt-parent-");
    const parent = path.join(directory, "one");
    await fs.mkdir(parent);
    const receipt = await prepare(directory, "one/two/value");
    const evidence = directoryObservation(parent);
    const child = path.join(parent, "two");
    await receipt.authorize(child);
    await fs.rename(parent, path.join(directory, "saved"));
    await fs.mkdir(child, { recursive: true });
    receipt.admission.advanceCreatedDirectory!(evidence, directoryObservation(child));
    await receipt.authorize();
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(2);
  });

  it("retains a frozen policy after the caller changes its arrays", async () => {
    const directory = await tempRoot("fs-safe-policy-receipt-snapshot-");
    const deniedParent = path.join(directory, "one", "two");
    const paths = [deniedParent];
    const prefixes: string[] = [];
    const receipt = await prepare(directory, "one/two/value", { paths, prefixes });
    await receipt.authorize();
    paths.length = 0;
    prefixes.push(directory);
    const first = path.join(directory, "one");
    const evidence = directoryObservation(directory);
    await receipt.authorize(first);
    await fs.mkdir(first);
    receipt.admission.advanceCreatedDirectory!(evidence, directoryObservation(first));
    await expect(receipt.authorize(deniedParent)).rejects.toMatchObject({ code: "denied-path" });
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(1);
  });

  it("invalidates configuration changes without caching or selecting a binding", async () => {
    configureFsSafeNative({ mode: "off" });
    const binding = vi.spyOn(native, "getNativeBinding");
    const directory = await tempRoot("fs-safe-policy-receipt-config-");
    const receipt = await prepare(directory, "one/value");
    await receipt.authorize();
    await receipt.authorize();
    configureFsSafeNative({ mode: "auto" });
    await receipt.authorize();
    configureFsSafeNative({ mode: "off" });
    await receipt.authorize();
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(3);
    expect(binding).not.toHaveBeenCalled();
  });

  it("refreshes incomplete canonical evidence through the existing full admission", async () => {
    const directory = await tempRoot("fs-safe-policy-receipt-incomplete-");
    const receipt = await prepare(directory, "one/value");
    await receipt.authorize();
    vi.spyOn(realpathSync, "native").mockImplementationOnce(() => {
      throw Object.assign(new Error("temporary canonicalization failure"), { code: "EACCES" });
    });
    await receipt.authorize();
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(2);
  });

  it("does not reuse observations that changed inside the full admission epoch", async () => {
    const directory = await tempRoot("fs-safe-policy-receipt-epoch-");
    const denied = path.join(directory, "unrelated");
    await fs.mkdir(denied);
    const receipt = await prepare(directory, "one/value", { prefixes: [denied] });
    const resolve = receipt.resolveCurrent.getMockImplementation()!;
    receipt.resolveCurrent.mockImplementationOnce(async () => {
      const current = await resolve();
      await fs.rename(denied, path.join(directory, "saved"));
      await fs.mkdir(denied);
      return current;
    });
    await receipt.authorize();
    await receipt.authorize();
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(2);
  });

  it("deopts an intentionally followed parent alias", async () => {
    const directory = await tempRoot("fs-safe-policy-receipt-alias-");
    await fs.mkdir(path.join(directory, "real"));
    await fs.symlink(path.join(directory, "real"), path.join(directory, "alias"), "dir");
    const receipt = await prepare(directory, "alias/value", undefined, "follow-parents-within-root");
    await receipt.authorize();
    await receipt.authorize();
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(2);
  });

  it("deopts home expansion even when its current expansion is an ordinary route", async () => {
    const directory = await tempRoot("fs-safe-policy-receipt-home-");
    vi.stubEnv("HOME", directory);
    const receipt = await prepare(directory, "~/one/value");
    await receipt.authorize();
    await receipt.authorize();
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(2);
  });

  it.each(["./one/value", "one/../one/value", "one//value"])("deopts the raw route %s", async (raw) => {
    const directory = await tempRoot("fs-safe-policy-receipt-complex-");
    await fs.mkdir(path.join(directory, "one"));
    const receipt = await prepare(directory, raw);
    await receipt.authorize();
    await receipt.authorize();
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(2);
  });

  it("refreshes a new target hardlink and preserves the full resolver's error", async () => {
    const directory = await tempRoot("fs-safe-policy-receipt-hardlink-");
    const target = path.join(directory, "value");
    await fs.writeFile(target, "original");
    const receipt = await prepare(directory, "value");
    await receipt.authorize();
    await fs.link(target, path.join(directory, "alias"));
    const marker = new FsSafeError("path-alias", "changed final identity");
    receipt.resolveCurrent.mockRejectedValueOnce(marker);
    await expect(receipt.authorize()).rejects.toBe(marker);
    expect(receipt.resolveCurrent).toHaveBeenCalledTimes(2);
  });
});
