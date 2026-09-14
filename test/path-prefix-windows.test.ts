import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePathPrefixSync } from "../src/path-prefix.js";
import { realpathSync } from "../src/realpath.js";

vi.mock("node:path", async importOriginal => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});

afterEach(() => vi.restoreAllMocks());

describe("Windows UNC path spelling with a simulated filesystem", () => {
  it.each(["D:\\", "\\\\?\\D:\\", "\\\\server\\share\\", "\\\\?\\UNC\\server\\share\\"])(
    "resolves root-relative symlink targets using their containing root %s",
    root => {
      const directoryStat = fs.lstatSync(process.cwd(), { bigint: true });
      const symlinkStat = Object.assign(Object.create(directoryStat), { isSymbolicLink: () => true });
      const alias = `${root}links\\alias`;
      vi.spyOn(process, "cwd").mockReturnValue("C:\\workspace");
      vi.spyOn(fs, "lstatSync").mockImplementation(input => {
        if (String(input) === alias) return symlinkStat;
        if ([`${root}links`, `${root}target`].includes(String(input))) return directoryStat;
        if (String(input) === `${root}target\\future`) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
        throw Object.assign(new Error("lookup lost the containing drive/share"), { code: "EIO" });
      });
      vi.spyOn(fs, "readlinkSync").mockReturnValue("\\target\\future");
      vi.spyOn(realpathSync, "native").mockImplementation(input => {
        if (input !== `${root}target`) throw new Error("canonicalization lost containing drive/share");
        return input;
      });
      expect(resolvePathPrefixSync(alias)).toEqual({
        absolutePath: alias, existingPath: `${root}target`, unresolvedSegments: ["future"],
      });
    },
  );

  it.each(["\\\\server\\share\\", "\\\\?\\UNC\\server\\share\\"])(
    "clamps traversal to the complete share root %s",
    root => {
      const directoryStat = fs.lstatSync(process.cwd(), { bigint: true });
      const present = new Set([root, root.slice(0, -1), `${root}child`]);
      vi.spyOn(fs, "lstatSync").mockImplementation(input => {
        if ([`${root}child\\..`, `${root}.`].includes(String(input))) return directoryStat;
        if (present.has(String(input))) return directoryStat;
        if (String(input) === `${root}future`) throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
        throw Object.assign(new Error("unexpected lookup outside the fixture share"), { code: "EIO" });
      });
      vi.spyOn(realpathSync, "native").mockImplementation(input => {
        if (!present.has(input)) throw new Error("canonicalization escaped fixture share");
        return root;
      });
      const input = `${root}child\\..\\..\\future`;
      expect(resolvePathPrefixSync(input)).toEqual({
        absolutePath: input, existingPath: root, unresolvedSegments: ["future"],
      });
    },
  );
});
