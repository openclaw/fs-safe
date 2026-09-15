import fs from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pathScope, resolvePathsWithinRoot, resolvePathWithinRoot } from "../src/root-paths.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();

describe("bulk lexical scope resolution", () => {
  it("matches sequential resolution across root and path spellings", () => {
    const component = fc.oneof(
      fc.constantFrom(".", "..", "", "..hidden", "é", "雪", "C:", "a\\b", " "),
      fc.string({ unit: "grapheme", maxLength: 12 }),
    );
    const spelling = fc.array(component, { maxLength: 8 }).map((parts) => parts.join("/"));
    fc.assert(fc.property(spelling, fc.array(spelling, { maxLength: 10 }), (rootDir, requestedPaths) => {
      const scopeLabel = "fixture";
      const paths: string[] = [];
      let expected: ReturnType<typeof resolvePathsWithinRoot> = { ok: true, paths };
      for (const requestedPath of requestedPaths) {
        const result = resolvePathWithinRoot({ rootDir, requestedPath, scopeLabel });
        if (!result.ok) {
          expected = result;
          break;
        }
        paths.push(result.path);
      }
      expect(resolvePathsWithinRoot({ rootDir, requestedPaths, scopeLabel })).toEqual(expected);
      expect(pathScope(rootDir, { label: scopeLabel }).resolveAll(requestedPaths)).toEqual(expected);
    }), { numRuns: 2000, seed: 20260915 });
  });

  it("does not inspect an unused root for an empty batch", () => {
    expect(resolvePathsWithinRoot({
      get rootDir(): string { throw new Error("unused root"); },
      requestedPaths: [],
      scopeLabel: "fixture",
    })).toEqual({ ok: true, paths: [] });
  });

  it("retains Node's invalid-root error for non-string runtime inputs", () => {
    for (const rootDir of [null, undefined, 42, {}] as unknown as string[]) {
      const params = { rootDir, requestedPath: "file", scopeLabel: "fixture" };
      let expected: unknown;
      try {
        resolvePathWithinRoot(params);
      } catch (error) {
        expected = error;
      }
      expect(expected).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
      expect(() => resolvePathsWithinRoot({ ...params, requestedPaths: ["file"] })).toThrow(expected as Error);
    }
  });

  it("reads changing root and label getters in their original per-item order", () => {
    const calls: string[] = [];
    let item = 0;
    const roots = [path.resolve("first"), path.resolve("second")];
    const result = resolvePathsWithinRoot({
      get rootDir() { calls.push(`root:${item}`); return roots[item++]!; },
      requestedPaths: ["a", "b"],
      get scopeLabel() { calls.push(`label:${item}`); return "fixture"; },
    });
    expect(result).toEqual({ ok: true, paths: [path.join(roots[0]!, "a"), path.join(roots[1]!, "b")] });
    expect(calls).toEqual(["root:0", "label:1", "root:1", "label:2"]);
  });

  it("stops before accessing any input after the first failure", () => {
    const requestedPaths = ["okay", "../escape", "unreachable"];
    Object.defineProperty(requestedPaths, "2", {
      get() { throw new Error("read beyond the first failure"); },
    });
    expect(pathScope(path.resolve("scope"), { label: "fixture" }).resolveAll(requestedPaths)).toEqual({
      ok: false, error: "Invalid path: must stay within fixture",
    });
  });

  it("keeps resolving a relative root after an input getter changes cwd", async () => {
    const base = await tempRoot("fs-safe-scope-bulk-cwd-");
    const first = path.join(base, "first"), second = path.join(base, "second");
    await fs.mkdir(first);
    await fs.mkdir(second);
    const requestedPaths = ["a", "b"];
    const scope = pathScope("relative", { label: "fixture" });
    Object.defineProperty(requestedPaths, "1", {
      get() { process.chdir(second); return "b"; },
    });
    const before = process.cwd();
    try {
      process.chdir(first);
      expect(scope.resolveAll(requestedPaths)).toEqual({
        ok: true, paths: [path.join(first, "relative", "a"), path.join(second, "relative", "b")],
      });
    } finally {
      process.chdir(before);
    }
  });
});
