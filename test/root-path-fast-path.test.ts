import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pathScope, resolvePathWithinRoot } from "../src/root-paths.js";
import { expandRelativePathWithHome } from "../src/root-context.js";
import {
  hasWindowsPathAlias,
  resolvePathFromBasePreservingWindowsRoot,
  resolvePathPreservingWindowsRoot,
} from "../src/windows-path-alias.js";
import { itWin32, useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platform);
});

function reference(rootDir: string, requestedPath: string, defaultFileName?: string) {
  const invalid = { ok: false as const, error: "Invalid path: must stay within fixture" };
  if (
    hasWindowsPathAlias(rootDir, "filesystem") ||
    hasWindowsPathAlias(requestedPath, "filesystem") ||
    (defaultFileName !== undefined && hasWindowsPathAlias(defaultFileName, "filesystem"))
  ) return invalid;
  const root = resolvePathPreservingWindowsRoot(rootDir);
  if (hasWindowsPathAlias(root, "filesystem")) return invalid;
  const raw = requestedPath.trim();
  if (!raw && !defaultFileName) return { ok: false, error: "path is required" };
  const resolved = resolvePathFromBasePreservingWindowsRoot(root, raw || defaultFileName!);
  if (hasWindowsPathAlias(resolved, "filesystem")) return invalid;
  const relative = path.relative(root, resolved);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? { ok: true, path: resolved }
    : invalid;
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

  it.each([" fallback.txt ", "   "])("does not trim the selected default %j", defaultName => {
    const rootDir = path.resolve("scope");
    expect(pathScope(rootDir, { label: "fixture" }).resolve(" \n", { defaultName })).toEqual({
      ok: true, path: path.join(rootDir, defaultName),
    });
  });

  it.each([".", "child/.."])("excludes the root when default %j resolves to it", defaultName => {
    expect(pathScope(path.resolve("scope"), { label: "fixture" }).resolve(" ", { defaultName })).toEqual({
      ok: false, error: "Invalid path: must stay within fixture",
    });
  });

  it("validates an unused Windows default alias before selecting the requested path", () => {
    const rootDir = path.resolve("scope");
    // This exercises lexical Windows admission without performing filesystem I/O.
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(pathScope(rootDir, { label: "fixture" }).resolve("valid.txt", { defaultName: "unused:stream" }))
      .toEqual({ ok: false, error: "Invalid path: must stay within fixture" });
  });

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

itWin32("keeps Windows alias admission on the ordinary-path fast path", async () => {
  vi.stubEnv("HOME", ""); vi.stubEnv("USERPROFILE", "");
  const home = vi.spyOn(os, "homedir").mockImplementation(() => { throw new Error("home unavailable"); });
  await expect(expandRelativePathWithHome("file:stream")).rejects.toMatchObject({
    code: "invalid-path",
    details: { reason: "windows-path-alias" },
  });
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
