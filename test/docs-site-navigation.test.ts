import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const builderScript = "scripts/build-docs-site.mjs";

// A committed two-level docs tree. The builder keys pages by their
// slash-separated path under docs/, so only a recursive reader reports the
// nested page as "guides/example.md".
const fixtureDocs = path.join("test", "fixtures", "docs-site-navigation");

async function readNavigationEntries(): Promise<string[]> {
  const script = await readFile(builderScript, "utf8");
  const block = /const sections = \[([\s\S]*?)\n\];/.exec(script);
  expect(block, "build-docs-site.mjs no longer declares a sections array").not.toBeNull();
  return [...block![1].matchAll(/"([^"]+\.md)"/g)].map((match) => match[1]!);
}

// Mirrors allMarkdown() in scripts/build-docs-site.mjs: the builder discovers pages
// recursively and keys them by their slash-separated path under docs/. A flat read
// would let a nested page pass here and then fail the production build after merge.
async function readDocPages(root = "docs", dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return await readDocPages(root, full);
      if (!entry.name.endsWith(".md")) return [];
      return [path.relative(root, full).split(path.sep).join("/")];
    }),
  );
  return nested.flat().sort();
}

describe("docs site navigation", () => {
  it("lists every documentation page in a sidebar section", async () => {
    const listed = await readNavigationEntries();
    const orphans = (await readDocPages()).filter((page) => !listed.includes(page));

    // An unlisted page still builds and still resolves from the index table, so
    // validateLinks() cannot see the drift: it renders without a sidebar entry,
    // without a previous/next pager, and under a fallback section label.
    expect(orphans).toEqual([]);
  });

  it("does not list a navigation entry that no longer exists", async () => {
    const pages = await readDocPages();
    const dangling = (await readNavigationEntries()).filter((entry) => !pages.includes(entry));

    // build-docs-site.mjs drops unknown entries with .filter(Boolean), so a
    // renamed or removed page leaves a silent hole in the sidebar.
    expect(dangling).toEqual([]);
  });

  it("lists each page exactly once", async () => {
    const listed = await readNavigationEntries();
    const duplicates = listed.filter((page, index) => listed.indexOf(page) !== index);

    expect(duplicates).toEqual([]);
  });

  it("discovers nested pages under their root-relative keys", async () => {
    // Guards the guard: docs/ is flat today, so a non-recursive read agrees with
    // the builder right now and would only diverge once someone adds a
    // subdirectory. Reading the committed fixture keeps that divergence visible
    // here instead of surfacing it as a broken build after merge.
    expect(await readDocPages(path.join(fixtureDocs, "docs"))).toEqual([
      "guides/example.md",
      "index.md",
    ]);
  });

  it("fails the site build for a nested page that no section lists", async () => {
    // The same fixture through the real builder: it resolves docs/ from the
    // working directory, so running it against the fixture proves the shipped
    // guard sees subdirectories and reports the same root-relative key.
    const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), "fs-safe-docs-nav-")));
    try {
      await cp(fixtureDocs, workspace, { recursive: true });
      const build = spawnSync(process.execPath, [path.resolve(builderScript)], {
        cwd: workspace,
        encoding: "utf8",
      });

      expect(build.status).toBe(1);
      expect(build.stderr).toContain(
        "docs/guides/example.md is not listed in any section, so it would build without navigation",
      );
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });
});
