import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { watchScopes } from "../src/watch-scan.js";

vi.mock("node:path", async importOriginal => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => { Object.defineProperty(process, "platform", { ...platform, value: "win32" }); });
afterEach(() => { Object.defineProperty(process, "platform", platform); });

it.each([
  ["./", ""], [".\\", ""], [".\\/", ""], ["child/", "child"], ["child\\", "child"],
  [".\\child/\\", "child"], ["child\\nested/\\", "child\\nested"],
])("canonicalizes Windows scope %j to %j", (supplied, normalized) => {
  expect(watchScopes([{ path: supplied, kind: "tree" }])).toEqual([{ path: normalized, kind: "tree", depth: 32 }]);
});

it.each([
  "..\\", "child\\..\\", "child/../", "C:\\child\\", "C:child\\", "\\child\\",
  "\\\\server\\share\\", "\\\\?\\C:\\child\\", "child:stream\\",
])("rejects Windows traversal and aliases before canonicalizing %j", supplied => {
  expect(() => watchScopes([{ path: supplied, kind: "tree" }])).toThrow();
});
