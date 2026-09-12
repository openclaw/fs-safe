import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { shortPath } from "../src/error-detail.js";

afterEach(() => vi.restoreAllMocks());

it("shortens only the home directory and its descendants", () => {
  const home = path.resolve("synthetic-home");
  vi.spyOn(os, "homedir").mockReturnValue(home);
  expect(shortPath(home)).toBe("~");
  expect(shortPath(path.join(home, "file"))).toBe(`~${path.sep}file`);
  expect(shortPath(`${home}-sibling`)).toBe(`${home}-sibling`);
  expect(shortPath(path.join(`${home}-sibling`, "file"))).toBe(path.join(`${home}-sibling`, "file"));
  expect(shortPath(path.join(home, "unsafe\nname"))).toBe(`~${path.sep}unsafe\\u000aname`);
});

it("preserves the separator when home is a filesystem root", () => {
  const home = path.parse(process.cwd()).root;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  expect(shortPath(home)).toBe("~");
  expect(shortPath(path.join(home, "file"))).toBe(`~${path.sep}file`);
});
