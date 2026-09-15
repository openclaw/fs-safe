import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRootPath, resolveRootPathSync } from "../src/root-path.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const flags = ["rejectSymlinks", "rejectFinalSymlink", "rejectUnresolvedSymlinks"] as const;
type Flag = typeof flags[number];

async function fixture() {
  const rootPath = await tempRoot("fs-safe-root-policy-");
  const nested = path.join(rootPath, "nested");
  const target = path.join(rootPath, "target");
  await fs.mkdir(nested);
  await fs.mkdir(target);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(nested, path.join(rootPath, "outer"), linkType);
  await fs.symlink(target, path.join(nested, "leaf"), linkType);
  await fs.symlink(path.join(rootPath, "missing"), path.join(rootPath, "dangling"), linkType);
  return { rootPath, target, absolutePath: path.join(rootPath, "outer", "leaf") };
}

describe("root traversal policy snapshots", () => {
  it.each(["async", "sync"] as const)("%s retains JavaScript null policy handling", async mode => {
    const rootPath = await tempRoot("fs-safe-root-null-policy-");
    const params = {
      rootPath, absolutePath: rootPath, boundaryLabel: "fixture",
      policy: null as unknown as undefined,
    };
    const result = mode === "async" ? await resolveRootPath(params) : resolveRootPathSync(params);
    expect(result).toMatchObject({ canonicalPath: rootPath, kind: "directory" });
  });

  it.each(["async", "sync"] as const)(
    "%s captures inherited non-enumerable policy getters once before traversal",
    async mode => {
      const f = await fixture();
      const reads: Record<Flag, number> = {
        rejectSymlinks: 0, rejectFinalSymlink: 0, rejectUnresolvedSymlinks: 0,
      };
      const prototype = Object.defineProperties({}, Object.fromEntries(flags.map(flag => [flag, {
        get: () => ++reads[flag] > 1,
      }])));
      const policyReads = { policy: 0, symlink: 0, hardlink: 0 };
      const policy = Object.create(Object.defineProperties({}, {
        allowFinalSymlinkForUnlink: { get: () => ++policyReads.symlink > 1 },
        allowFinalHardlinkForUnlink: { get: () => {
          policyReads.hardlink += 1;
          throw new Error("unused hardlink policy getter evaluated");
        } },
      }));
      Object.defineProperty(prototype, "policy", {
        get: () => { policyReads.policy += 1; return policy; },
      });
      const params = Object.assign(Object.create(prototype), {
        rootPath: f.rootPath, absolutePath: f.absolutePath, boundaryLabel: "fixture",
      });
      const result = mode === "async" ? await resolveRootPath(params) : resolveRootPathSync(params);
      expect(result).toMatchObject({ canonicalPath: f.target, kind: "directory" });
      expect(reads).toEqual({
        rejectSymlinks: 1, rejectFinalSymlink: 1, rejectUnresolvedSymlinks: 1,
      });
      expect(policyReads).toEqual({ policy: 1, symlink: 1, hardlink: 0 });
    },
  );

  it.each(flags)("retains %s while ancestor resolution yields", async flag => {
    const f = await fixture();
    const params = {
      rootPath: f.rootPath,
      absolutePath: flag === "rejectUnresolvedSymlinks"
        ? path.join(f.rootPath, "dangling") : f.absolutePath,
      boundaryLabel: "fixture",
      rejectSymlinks: false,
      rejectFinalSymlink: false,
      rejectUnresolvedSymlinks: false,
    };
    params[flag] = true;
    const pending = resolveRootPath(params);
    params[flag] = false;
    await expect(pending).rejects.toMatchObject({ code: "symlink" });
  });

  it("owns nested alias policy while ancestor resolution yields", async () => {
    const f = await fixture();
    const policy = { allowFinalSymlinkForUnlink: false, allowFinalHardlinkForUnlink: false };
    const params = {
      rootPath: f.rootPath, absolutePath: f.absolutePath, boundaryLabel: "fixture", policy,
    };
    const pending = resolveRootPath(params);
    policy.allowFinalSymlinkForUnlink = true;
    policy.allowFinalHardlinkForUnlink = true;
    params.policy = { allowFinalSymlinkForUnlink: true, allowFinalHardlinkForUnlink: true };
    await expect(pending).resolves.toMatchObject({ canonicalPath: f.target, kind: "directory" });
  });
});
