import path from "node:path";
import { describe, expect, it } from "vitest";
import { changedEntries, nativeChanges } from "../src/watch-hints.js";
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
      expect(nativeChanges(scopes, undefined, { overflow: false, hints: [{ directory: "", name, event: "rename" }] })).toBeUndefined();
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
