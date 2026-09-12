import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expandHomePrefix, resolveEffectiveHomeDir, resolveHomeRelativePath } from "../src/home-dir.js";
import { readLocalFileFromRoots } from "../src/local-roots.js";
import { useTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useTempDirs();
afterEach(() => vi.unstubAllEnvs());

describe("home prefix resolution", () => {
  const home = path.resolve("synthetic", "home");

  it.each(["~/../shared", "~/child/../../shared", "~//../shared"])(
    "expands the home before parent traversal: %s", (input) => {
      const expected = path.join(home, "..", "shared");
      expect(expandHomePrefix(input, { home })).toBe(expected);
      expect(resolveHomeRelativePath(input, { env: { HOME: home } })).toBe(expected);
      expect(resolveEffectiveHomeDir({ HOME: home, OPENCLAW_HOME: input })).toBe(expected);
    },
  );

  it.each(["./~/file", "child/../~/file", "~other/file"])(
    "keeps a non-leading tilde literal: %s", (input) => {
      expect(expandHomePrefix(input, { home })).toBe(input);
      expect(resolveHomeRelativePath(input, { env: { HOME: home } })).toBe(path.resolve(input));
    },
  );

  it("preserves bare tilde, missing home, and empty input behavior", () => {
    expect(expandHomePrefix("~", { home })).toBe(home);
    expect(expandHomePrefix("~/../shared", { env: {}, homedir: () => "" })).toBe("~/../shared");
    expect(resolveHomeRelativePath("", { env: { HOME: home } })).toBe("");
  });

  it.skipIf(process.platform !== "win32")("supports backslash and mixed Windows separators", () => {
    for (const input of ["~\\..\\shared", "~/child\\..\\..\\shared"]) {
      expect(expandHomePrefix(input, { home })).toBe(path.join(home, "..", "shared"));
    }
  });

  it("reads a parent-relative home path through the configured root boundary", async () => {
    const dir = await tempRoot("fs-safe-home-prefix-");
    const fixtureHome = path.join(dir, "home");
    await fs.mkdir(fixtureHome);
    await fs.writeFile(path.join(dir, "shared.txt"), "shared contents");
    vi.stubEnv("OPENCLAW_HOME", fixtureHome);
    const input = { filePath: "~/../shared.txt", roots: [dir] };
    const result = await readLocalFileFromRoots(input);
    expect(result?.buffer.toString()).toBe("shared contents");
    expect(await readLocalFileFromRoots({ ...input, roots: [fixtureHome] })).toBeNull();
  });
});
