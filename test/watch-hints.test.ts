import path from "node:path";
import { describe, expect, it } from "vitest";
import { changedEntries, guardedHintChanges, nativeChanges } from "../src/watch-hints.js";
import { watchScopes, type WatchSnapshot } from "../src/watch-scan.js";
const snapshot = (entries: [string, string][]): WatchSnapshot => ({ entries: new Map(entries), directories: new Map(), targets: new Map(), scanned: entries.length });
const scopes = watchScopes([{ path: "config.json", kind: "entry" }, { path: "skills", kind: "tree", depth: 2 }]);

describe("bounded advisory hints", () => {
  it("preserves exact entry scopes and filename-relative detail", () => {
    const before = snapshot([["config.json", "file:1:2:3:4:5"]]);
    expect(nativeChanges(scopes, before, { overflow: false, hints: [{ directory: "", name: "config.json", event: "change" }] })).toEqual([{ path: "config.json", type: "content" }]);
    expect(nativeChanges(scopes, before, { overflow: false, hints: [{ directory: "config.json", name: "child", event: "change" }] })).toEqual([]);
    expect(nativeChanges(scopes, before, { overflow: false, hints: [{ directory: "", name: "unrelated", event: "rename" }] })).toEqual([]);
  });
  it("invalidates a missing descendant on ancestor replacement", () => {
    expect(nativeChanges(watchScopes([{ path: "a/b/config", kind: "entry" }]), undefined, { overflow: false, hints: [{ directory: "", name: "a", event: "rename" }] })).toEqual([{ path: path.join("a", "b", "config"), type: "structural" }]);
  });
  it("makes unknown, escaping names and overflow explicit scope invalidation", () => {
    for (const name of [null, "", "../outside", ".", "..", "a/b", "bad\0name"]) {
      expect(nativeChanges(scopes, undefined, { overflow: false, hints: [{ directory: "", name: name as string, event: "rename" }] })).toBeUndefined();
    }
    expect(nativeChanges(scopes, undefined, { overflow: true, hints: [] })).toBeUndefined();
  });
  it("distinguishes structural and content reconciliation without using numeric metadata as authority", () => {
    const before = snapshot([["file", "file:1:2:3:4:5"], ["link", "symlink:1:3:4:5:6"]]);
    const after = snapshot([["file", "file:1:2:4:5:5"], ["link", "symlink:1:4:4:5:6"]]);
    expect(changedEntries(before, after, 2)).toEqual([{ path: "file", type: "content" }, { path: "link", type: "structural" }]);
    expect(changedEntries(before, after, 1)).toBeUndefined();
    expect(changedEntries(undefined, after, 2)).toBeUndefined();
  });
});


it("retains admitted namespace activity despite equal before/after fingerprints", () => {
  const before = snapshot([["config.json", "file:1:2:3:4:5"]]);
  const after = snapshot([["config.json", "file:1:2:3:4:5"]]);
  const observed = changedEntries(before, after, 256);
  expect(observed).toEqual([]);
  const hints = nativeChanges(scopes, before, { overflow: false, hints: [{ directory: "", name: "config.json", event: "rename" }] });
  expect(guardedHintChanges(scopes, before, after, hints, observed, 256)).toEqual([{ path: "config.json", type: "structural" }]);
});

describe("unobserved transient hints", () => {
  const identity = { dev: 1n, ino: 2n };
  const hint = { path: path.join("skills", "save.tmp"), type: "structural" as const };
  it.each(["", "skills"])("drops a name under the same parent identity at %j without spending detail budget", parent => {
    const before = snapshot([]), after = snapshot([]);
    before.directories.set(parent, identity);
    after.directories.set(parent, { ...identity });
    const transient = { ...hint, path: parent ? path.join(parent, "save.tmp") : "save.tmp" };
    const observed = [{ path: "config.json", type: "content" as const }];
    expect(guardedHintChanges(watchScopes([{ path: "", kind: "tree" }]), before, after, [transient], [], 1)).toEqual([]);
    expect(guardedHintChanges(scopes, before, after, [transient], observed, 1)).toEqual(observed);
  });
  it.each([{ dev: 2n, ino: 2n }, { dev: 1n, ino: 3n }])("erases detail when the parent identity changes ($dev, $ino)", changed => {
    const before = snapshot([]), after = snapshot([]);
    before.directories.set("skills", identity);
    after.directories.set("skills", changed);
    expect(guardedHintChanges(scopes, before, after, [hint], [], 256)).toBeUndefined();
  });
  it.each(["before", "after"] as const)("erases detail when the parent is missing in %s", missing => {
    const before = snapshot([]), after = snapshot([]);
    (missing === "before" ? after : before).directories.set("skills", identity);
    expect(guardedHintChanges(scopes, before, after, [hint], [], 256)).toBeUndefined();
  });
  it("still admits an explicit scope target absent from both snapshots", () => {
    const target = { path: "config.json", type: "structural" as const };
    expect(guardedHintChanges(scopes, snapshot([]), snapshot([]), [target], [], 1)).toEqual([target]);
  });
});
