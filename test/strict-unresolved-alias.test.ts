import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAbsolutePathForWrite } from "../src/absolute-path.js";
import { resolveLocalPathFromRootsSync } from "../src/local-roots.js";
import { expectFsSafeError } from "./helpers/security.js";
import { itPosix, useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

describe("strict unresolved alias handling", () => {
  it("distinguishes dangling aliases from truly missing suffixes", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-unresolved-alias-root-"));
    const outside = await fs.realpath(
      await tempRoot("fs-safe-unresolved-alias-outside-"),
    );
    const dangling = path.join(root, "dangling");
    const danglingChild = path.join(dangling, "child.txt");
    const missing = path.join(root, "missing", "child.txt");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(path.join(outside, "absent"), dangling, linkType);

    expect(
      resolveLocalPathFromRootsSync({
        filePath: dangling,
        roots: [root],
        allowMissing: true,
      }),
    ).toBeNull();
    expect(
      resolveLocalPathFromRootsSync({
        filePath: danglingChild,
        roots: [root],
        allowMissing: true,
      }),
    ).toBeNull();
    expect(
      resolveLocalPathFromRootsSync({
        filePath: missing,
        roots: [root],
        allowMissing: true,
      }),
    ).toEqual({ path: missing, root });

    await expectFsSafeError(resolveAbsolutePathForWrite(dangling), "symlink");
    await expectFsSafeError(resolveAbsolutePathForWrite(danglingChild), "symlink");
    await expect(resolveAbsolutePathForWrite(dangling, { symlinks: "follow" }))
      .resolves.toMatchObject({ path: dangling, canonicalPath: dangling });
  });

  it("keeps following resolvable in-root aliases for local missing paths", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-resolved-alias-root-"));
    const actual = path.join(root, "actual");
    const alias = path.join(root, "alias");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    await fs.mkdir(actual);
    await fs.symlink(actual, alias, linkType);

    expect(
      resolveLocalPathFromRootsSync({
        filePath: path.join(alias, "future.txt"),
        roots: [root],
        allowMissing: true,
      }),
    ).toEqual({ path: path.join(actual, "future.txt"), root });
  });

  itPosix("preserves requireFile semantics for a symlink leaf", async () => {
    const root = await fs.realpath(await tempRoot("fs-safe-alias-file-root-"));
    const actual = path.join(root, "actual.txt");
    const alias = path.join(root, "alias.txt");
    await fs.writeFile(actual, "value");
    await fs.symlink(actual, alias, "file");

    expect(resolveLocalPathFromRootsSync({ filePath: alias, roots: [root] })).toEqual({
      path: actual,
      root,
    });
    expect(
      resolveLocalPathFromRootsSync({
        filePath: alias,
        roots: [root],
        requireFile: true,
      }),
    ).toBeNull();
  });
});
