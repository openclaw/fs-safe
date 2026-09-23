import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirPathComponentsWithGuards } from "../src/guarded-mkdir.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import {
  preparePinnedWriteMutationAdmission,
  snapshotPinnedMutationPolicy,
} from "../src/pinned-mutation-admission.js";
import * as rootBoundary from "../src/root-boundary.js";
import { resolveRootContext } from "../src/root-context.js";
import { root } from "../src/root.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
});

async function aliasedRoot(prefix: string) {
  const container = await tempRoot(prefix);
  const realAncestor = path.join(container, "real-ancestor");
  const aliasAncestor = path.join(container, "alias-ancestor");
  const canonicalRoot = path.join(realAncestor, "root");
  await fs.mkdir(canonicalRoot, { recursive: true });
  await fs.symlink(realAncestor, aliasAncestor, process.platform === "win32" ? "junction" : "dir");
  const configuredRoot = path.join(aliasAncestor, "root");
  const stat = await fs.lstat(configuredRoot, { bigint: true });
  return {
    canonicalRoot: await fs.realpath(canonicalRoot),
    configuredRoot,
    identity: { dev: stat.dev, ino: stat.ino },
  };
}

describe("integrated guarded mutation walk", () => {
  it("keeps exact guards through configured roots, existing directories, aliases, and receipts", async () => {
    const fixture = await aliasedRoot("fs-safe-policy-integrated-guard-");
    const existing = path.join(fixture.canonicalRoot, "existing");
    const canonicalAliasTarget = path.join(fixture.canonicalRoot, "canonical-alias-target");
    const alias = path.join(existing, "alias");
    await fs.mkdir(existing);
    await fs.mkdir(canonicalAliasTarget);
    await fs.symlink(
      canonicalAliasTarget,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    const admission = Object.freeze({});
    const authorization = Object.freeze({});
    const createdParents: string[] = [];
    const existingComponents: string[] = [];
    const configuredTarget = path.join(fixture.configuredRoot, "existing", "alias", "one", "two");
    const result = await mkdirPathComponentsWithGuards({
      rootReal: fixture.configuredRoot,
      rootIdentity: fixture.identity,
      targetPath: configuredTarget,
      beforeCreateComponent(componentPath, _prospectiveTarget, _retainedTarget, parent) {
        expect(typeof parent.identity.dev).toBe("bigint");
        expect(typeof parent.identity.ino).toBe("bigint");
        createdParents.push(parent.path);
        expect(componentPath).toBe(path.join(parent.path, path.basename(componentPath)));
        return admission;
      },
      beforeUseComponent(componentPath) {
        existingComponents.push(componentPath);
      },
      afterCreateComponent(receipt) {
        expect(receipt.admission).toBe(admission);
        expect(typeof receipt.parent.identity.dev).toBe("bigint");
        expect(typeof receipt.child.identity.dev).toBe("bigint");
        expect(Object.isFrozen(receipt)).toBe(true);
        return authorization;
      },
    });

    expect(existingComponents).toEqual([existing, alias]);
    expect(createdParents).toEqual([
      canonicalAliasTarget,
      path.join(canonicalAliasTarget, "one"),
    ]);
    expect(result).toBe(path.join(canonicalAliasTarget, "one", "two"));
    expect((await fs.lstat(result)).isDirectory()).toBe(true);

    const canonicalTarget = path.join(fixture.canonicalRoot, "canonical-spelling", "leaf");
    await expect(mkdirPathComponentsWithGuards({
      rootReal: fixture.configuredRoot,
      rootIdentity: fixture.identity,
      targetPath: canonicalTarget,
    })).resolves.toBe(canonicalTarget);
  });

  it("admits a canonical parent with the configured Root identity and trusted suffix", async () => {
    const directory = await tempRoot("fs-safe-policy-integrated-parent-");
    const parent = path.join(directory, "existing");
    const target = path.join(parent, "value");
    await fs.mkdir(parent);
    const context = await resolveRootContext(directory);
    const policy = snapshotPinnedMutationPolicy(undefined, "reject")!;
    const admission = vi.spyOn(rootBoundary, "requirePathInsideRoot");

    const prepared = await preparePinnedWriteMutationAdmission({
      ...context,
      resolvedTargetPath: target,
      defaultRelativeParentPath: "wrong",
      originalPath: "existing/value",
      policy,
      resolveCurrent: async () => ({ resolved: target }),
    });

    expect(prepared.relativeParentPath).toBe("existing");
    expect(admission).toHaveBeenCalledOnce();
    expect(admission).toHaveBeenCalledWith(
      context.rootReal,
      await fs.realpath(parent),
      context.rootIdentity,
    );
  });
});

describe("integrated fallback policy fences", () => {
  it("denies a deeper missing parent before creating that component", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-policy-integrated-deny-");
    const denied = path.join(directory, "one", "two");
    const safe = await root(directory);

    await expect(safe.write("one/two/three/value", "payload", {
      durable: false,
      denyMutations: { paths: [denied] },
    })).rejects.toMatchObject({ code: "denied-path" });

    expect(await fs.readdir(path.join(directory, "one"))).toEqual([]);
    await expect(fs.lstat(denied)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors revocation before dispatching any later directory or staging mutation", async () => {
    configureFsSafeNative({ mode: "off" });
    const directory = await tempRoot("fs-safe-policy-integrated-revoke-");
    const safe = await root(directory);
    const revoked = new Error("mutation authority revoked");
    let checks = 0;

    await expect(safe.write("one/two/three/value", "payload", {
      durable: false,
      mutationSymlinks: "reject",
      assertBeforeMutation() {
        checks += 1;
        if (checks > 1) throw revoked;
      },
    })).rejects.toBe(revoked);

    expect(checks).toBe(2);
    expect(await fs.readdir(path.join(directory, "one"))).toEqual([]);
    await expect(fs.lstat(path.join(directory, "one", "two"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(directory)).some((entry) => entry.startsWith(".fs-safe-"))).toBe(false);
  });
});
