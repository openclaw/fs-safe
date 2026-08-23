import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function readNavigationEntries(): Promise<string[]> {
  const script = await readFile("scripts/build-docs-site.mjs", "utf8");
  const block = /const sections = \[([\s\S]*?)\n\];/.exec(script);
  expect(block, "build-docs-site.mjs no longer declares a sections array").not.toBeNull();
  return [...block![1].matchAll(/"([^"]+\.md)"/g)].map((match) => match[1]!);
}

async function readDocPages(): Promise<string[]> {
  const entries = await readdir("docs");
  return entries.filter((entry) => entry.endsWith(".md"));
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
});
