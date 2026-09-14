import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathScope, resolvePathWithinRoot } from "../src/root-paths.js";
import { expandRelativePathWithHome } from "../src/root-context.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function reference(rootDir: string, requestedPath: string, defaultFileName?: string) {
  const root = path.resolve(rootDir);
  const raw = requestedPath.trim();
  if (!raw && !defaultFileName) return { ok: false, error: "path is required" };
  const resolved = path.resolve(root, raw || defaultFileName!);
  const relative = path.relative(root, resolved);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? { ok: true, path: resolved }
    : { ok: false, error: "Invalid path: must stay within fixture" };
}

describe("lexical path-scope containment", () => {
  it("matches relative-path containment for mixed normalized and raw spellings", () => {
    const component = fc.oneof(fc.constantFrom(".", "..", "", "..hidden", "é", "雪", "C:", "a\\b", " "),
      fc.string({ unit: "grapheme", maxLength: 12 }));
    const spelling = fc.array(component, { maxLength: 12 }).map(parts => parts.join("/"));
    fc.assert(fc.property(spelling, spelling, (rootDir, requestedPath) => {
      expect(resolvePathWithinRoot({ rootDir, requestedPath, scopeLabel: "fixture" }))
        .toEqual(reference(rootDir, requestedPath));
    }), { numRuns: 5000, seed: 24321 });
  });

  it.each([".", "child/..", "../outside", "../scope-sibling/file", "..hidden/file", "nested/../file", " "])(
    "preserves root exclusion, escapes, and defaults for %s", (requestedPath) => {
      const rootDir = path.resolve("scope");
      expect(resolvePathWithinRoot({ rootDir, requestedPath, scopeLabel: "fixture", defaultFileName: "default" }))
        .toEqual(reference(rootDir, requestedPath, "default"));
    },
  );

  it("preserves bulk order and fails at the first invalid path", () => {
    const rootDir = path.resolve("scope"), scope = pathScope(rootDir, { label: "fixture" });
    const values = [" b ", "a/../c", "..hidden"];
    expect(scope.resolveAll(values)).toEqual({ ok: true, paths: values.map(value => path.resolve(rootDir, value.trim())) });
    expect(scope.resolveAll(["okay", "../outside", " "])).toEqual(reference(rootDir, "../outside"));
  });
});

it("does not resolve the user's home for ordinary Root paths", async () => {
  vi.stubEnv("HOME", ""); vi.stubEnv("USERPROFILE", "");
  const home = vi.spyOn(os, "homedir").mockImplementation(() => { throw new Error("home unavailable"); });
  for (const value of ["file", ".", "", "a/../b", "~other/file", "nested/~/file"]) {
    expect(await expandRelativePathWithHome(value)).toBe(value);
  }
  expect(home).not.toHaveBeenCalled();
});

it("observes home changes when expansion is actually requested", async () => {
  const base = await tempRoot("fs-safe-home-demand-");
  for (const name of ["first", "second"]) {
    const home = path.join(base, name);
    await fs.mkdir(home);
    vi.stubEnv("HOME", home);
    expect(await expandRelativePathWithHome("ordinary")).toBe("ordinary");
    expect(await expandRelativePathWithHome("~")).toBe(home);
    expect(await expandRelativePathWithHome("~/../peer")).toBe(`${home}${path.sep}../peer`);
  }
});
