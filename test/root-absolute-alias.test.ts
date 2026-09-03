import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { root as openRoot } from "../src/index.js";
import { expectFsSafeError } from "./helpers/security.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();

describe("Root absolute reads through configured aliases", () => {
  it("accepts configured and canonical in-root spellings", async () => {
    const container = await tempRoot("fs-safe-reader-root-alias-");
    const canonicalRoot = path.join(container, "canonical");
    const rootAlias = path.join(container, "alias");
    const outsidePath = path.join(container, "outside.txt");
    const nestedRoot = path.join(canonicalRoot, "nested");
    const nestedAlias = path.join(canonicalRoot, "nested-alias");
    await fs.mkdir(canonicalRoot);
    await fs.mkdir(nestedRoot);
    await fs.writeFile(path.join(canonicalRoot, "value.txt"), "inside");
    await fs.writeFile(path.join(nestedRoot, "value.txt"), "nested");
    await fs.writeFile(outsidePath, "outside");
    const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(canonicalRoot, rootAlias, directoryLinkType);
    await fs.symlink(nestedRoot, nestedAlias, directoryLinkType);

    const root = await openRoot(rootAlias);
    const configuredPath = path.join(root.rootDir, "value.txt");
    const canonicalPath = path.join(root.rootReal, "value.txt");
    const canonicalAliasPath = path.join(root.rootReal, "nested-alias", "value.txt");

    expect(root.rootDir).not.toBe(root.rootReal);
    await expect(root.readAbsolute(configuredPath)).resolves.toMatchObject({
      buffer: Buffer.from("inside"),
    });
    await expect(root.readAbsolute(canonicalPath)).resolves.toMatchObject({
      buffer: Buffer.from("inside"),
    });
    await expect(root.reader()(configuredPath)).resolves.toEqual(Buffer.from("inside"));
    await expect(root.reader()(canonicalPath)).resolves.toEqual(Buffer.from("inside"));
    await expect(root.readText(canonicalPath)).resolves.toBe("inside");

    await expectFsSafeError(root.readAbsolute(canonicalAliasPath), "symlink");
    await expect(
      root.readAbsolute(canonicalAliasPath, { symlinks: "follow-within-root" }),
    ).resolves.toMatchObject({ buffer: Buffer.from("nested") });
    await expect(
      root.reader({ symlinks: "follow-within-root" })(canonicalAliasPath),
    ).resolves.toEqual(Buffer.from("nested"));

    await expectFsSafeError(root.readAbsolute(outsidePath), "outside-workspace");
    await expectFsSafeError(root.reader()(outsidePath), "outside-workspace");
  });
});
