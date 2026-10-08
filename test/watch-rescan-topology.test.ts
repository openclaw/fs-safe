import path from "node:path";
import { expect, it } from "vitest";
import { mergeWatchRescan } from "../src/watch-rescan.js";
import type { WatchSnapshot } from "../src/watch-scan.js";

it.each(["created", "removed", "replaced", "file-to-directory", "directory-to-file"])("requires a full pass for a %s child directory", scenario => {
  const child = path.join("tree", "child");
  const before: WatchSnapshot = {
    entries: new Map([["tree", "directory:1:2:493"], [child, "directory:1:3:493"]]),
    directories: new Map([["tree", { dev: 1n, ino: 2n }]]), targets: new Map(), scanned: 1,
    childPaths: new Map([["tree", new Map([["child", child]])]]), listed: new Map([["tree", 1]]),
  };
  const slice = { ...before, entries: new Map(before.entries) };
  if (scenario === "created") before.entries.delete(child);
  if (scenario === "removed") slice.entries.delete(child);
  if (scenario === "replaced") slice.entries.set(child, "directory:1:4:493");
  if (scenario === "file-to-directory") before.entries.set(child, "file:1:3:1:1:420");
  if (scenario === "directory-to-file") slice.entries.set(child, "file:1:3:1:1:420");
  const scopes = [{ path: "tree", kind: "tree" as const, depth: 2 }];
  expect(mergeWatchRescan(scopes, before, slice, [{ ...scopes[0]!, depth: 1 }])).toBeUndefined();
});
