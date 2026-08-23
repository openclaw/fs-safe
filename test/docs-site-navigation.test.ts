import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function readNavigationEntries(): Promise<string[]> {
  const script = await readFile("scripts/build-docs-site.mjs", "utf8");
  const block = /const sections = \[([\s\S]*?)\n\];/.exec(script);
  expect(block, "build-docs-site.mjs no longer declares a sections array").not.toBeNull();
  return [...block![1].matchAll(/"([^"]+\.md)"/g)].map((match) => match[1]!);
}

// Mirrors allMarkdown() in scripts/build-docs-site.mjs: the builder discovers pages
// recursively and keys them by their slash-separated path under docs/. A flat read
// would let a nested page pass here and then fail the production build after merge.
async function readDocPages(dir = "docs"): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return await readDocPages(full);
      if (!entry.name.endsWith(".md")) return [];
      return [path.relative("docs", full).split(path.sep).join("/")];
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

  it("discovers nested pages the way the builder does", async () => {
    // Guards the guard: docs/ is flat today, so a non-recursive read would agree
    // with the builder right now and only diverge once someone adds a subdirectory.
    const pages = await readDocPages();
    const flat = (await readdir("docs")).filter((entry) => entry.endsWith(".md"));

    expect(pages).toEqual(expect.arrayContaining(flat));
    expect(pages.length).toBeGreaterThanOrEqual(flat.length);
  });
});
