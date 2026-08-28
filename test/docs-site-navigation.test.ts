import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertNavigationCoversDocs, readDocPages, sections } from "../scripts/docs-site-navigation.mjs";

const docsDir = path.resolve("docs");
const builder = path.resolve("scripts/build-docs-site.mjs");
const fixtureDocs = path.resolve("test/fixtures/docs-site-navigation/docs");
const tempDirs: string[] = [];

function scratchDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fs-safe-docs-"));
  tempDirs.push(dir);
  return dir;
}

function nestedFixture() {
  const dir = scratchDir();
  cpSync(fixtureDocs, dir, { recursive: true });
  mkdirSync(path.join(dir, "guides", "nested"), { recursive: true });
  for (const rel of ["guides/nested/detail.md", "notes.txt", "guides/image.svg"]) {
    writeFileSync(path.join(dir, rel), "# Example\n");
  }
  return dir;
}

function siteFixture(sourceDocs = docsDir) {
  const root = scratchDir();
  cpSync(sourceDocs, path.join(root, "docs"), { recursive: true });
  const output = path.join(root, "dist", "docs-site");
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "keep.txt"), "previous site");
  return { root, output };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("docs site navigation", () => {
  it("discovers the committed fixture under exact root-relative keys", () => {
    expect(readDocPages(fixtureDocs)).toEqual(["guides/example.md", "index.md"]);
  });

  it("discovers flat and nested Markdown pages, ignoring other files", () => {
    expect(readDocPages(nestedFixture())).toEqual(["guides/example.md", "guides/nested/detail.md", "index.md"]);
  });

  it("applies exclusions to slash-separated paths relative to docs", () => {
    const pages = readDocPages(nestedFixture(), [/^guides\//]);
    expect(pages).toEqual(["index.md"]);
    expect(() => assertNavigationCoversDocs(pages, [["Start", ["index.md"]]])).not.toThrow();
    expect(() => assertNavigationCoversDocs(pages, [["Start", ["index.md", "guides/example.md"]]]))
      .toThrow("guides/example.md, which does not exist in docs/ or is excluded");
  });

  it("reports missing nested registrations by their full relative filename", () => {
    expect(() => assertNavigationCoversDocs(readDocPages(nestedFixture()), [["Start", ["index.md"]]]))
      .toThrow("docs/guides/example.md is not listed in any section");
  });

  it("reports nonexistent navigation targets", () => {
    expect(() => assertNavigationCoversDocs(["index.md"], [["Start", ["index.md", "ghost.md"]]]))
      .toThrow('section "Start" lists ghost.md, which does not exist');
  });

  it.each([
    [["Start", ["index.md", "index.md"]]],
    [["Start", ["index.md"]], ["Other", ["index.md"]]],
  ])("rejects duplicate targets within or across sections: %j", (...navigation) => {
    expect(() => assertNavigationCoversDocs(["index.md"], navigation))
      .toThrow("docs/index.md is listed more than once");
  });

  it("accepts complete flat and nested registrations", () => {
    expect(() => assertNavigationCoversDocs(readDocPages(nestedFixture()), [
      ["Start", ["index.md"]],
      ["Guides", ["guides/example.md", "guides/nested/detail.md"]],
    ])).not.toThrow();
  });

  it("covers the full repository inventory and retains staged-file in Atomic & temp", () => {
    expect(() => assertNavigationCoversDocs(readDocPages(docsDir))).not.toThrow();
    expect(sections.find(([name]) => name === "Atomic & temp")?.[1])
      .toEqual(["atomic.md", "staged-file.md", "durability.md", "output.md", "json.md", "temp.md", "archive.md"]);
  });

  it.each(["missing nested registration", "nonexistent target"])("the builder rejects %s before replacing output", (problem) => {
    const { root, output } = siteFixture(problem === "missing nested registration" ? fixtureDocs : docsDir);
    if (problem === "nonexistent target") {
      rmSync(path.join(root, "docs", "durability.md"));
    }
    const result = spawnSync(process.execPath, [builder], { cwd: root, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(problem === "missing nested registration"
      ? "docs/guides/example.md is not listed in any section"
      : "lists durability.md, which does not exist");
    expect(readFileSync(path.join(output, "keep.txt"), "utf8")).toBe("previous site");
  });

  it("builds the real docs with sidebar, section, and pager links for repaired pages and staging", () => {
    const { root, output } = siteFixture();
    const result = spawnSync(process.execPath, [builder], { cwd: root, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("built docs site:");
    for (const [page, section, prev, next] of [
      ["walk", "Root API", "writing", "path-scope"],
      ["staged-file", "Atomic &amp; temp", "atomic", "durability"],
      ["durability", "Atomic &amp; temp", "staged-file", "output"],
      ["secure-file", "Specialized", "secret-file", "permissions"],
      ["permissions", "Specialized", "secure-file", "regular-file"],
      ["public-api", "Reference", "types", "testing"],
      ["migrating-to-0.5", "Reference", "test-hooks", "contributing"],
    ]) {
      const html = readFileSync(path.join(output, `${page}.html`), "utf8");
      expect(html).toContain(`<a class="nav-link active" href="${page}.html">`);
      expect(html).toContain(`<p class="eyebrow">${section}</p>`);
      expect(html).toContain(`<a class="page-nav-prev" href="${prev}.html">`);
      expect(html).toContain(`<a class="page-nav-next" href="${next}.html">`);
      expect(html).not.toContain('href="pinned-open.html"');
    }
  });
});
