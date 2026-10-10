import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { documentedImportFailures } from "../scripts/documented-imports.mjs";

afterEach(() => vi.restoreAllMocks());

it.each(["\n", "\r\n"])("checks fenced imports with %j line endings", newline => {
  const read = fs.readFileSync;
  const markdown = [
    "# Example",
    "```ts",
    'import { root } from "@openclaw/fs-safe/not-public";',
    "```",
  ].join(newline);
  vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
    return String(file).endsWith(`${path.sep}README.md`)
      ? markdown
      : read(file, options);
  });
  expect(documentedImportFailures()).toEqual([
    "README.md:2: unknown package subpath ./not-public",
  ]);
});
