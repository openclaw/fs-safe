import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { guardedHintChanges, nativeChanges, selectedWatchChildren, selectedWatchSubtree } from "../src/watch-hints.js";
import type { WatchSnapshot } from "../src/watch-scan.js";
import type { WatchChange, WatchScope } from "../src/watch-types.js";

const name = fc.array(fc.constantFrom("a", "b", "ab", "café", "cafe\u0301", "UPPER", ".save-tmp"), { maxLength: 4 }).map(parts => parts.join(path.sep));
const scope = fc.record({ path: name, kind: fc.constantFrom("entry" as const, "tree" as const), depth: fc.integer({ min: 0, max: 4 }) });
const change = fc.record({ path: name, type: fc.constantFrom("content" as const, "structural" as const) });
const components = (value: string) => value ? value.split(path.sep) : [];
function distance(parent: string, child: string): number {
  const left = components(parent), right = components(child);
  return left.every((part, i) => right[i] === part) ? right.length - left.length : -1;
}
function selected(scopes: WatchScope[], name: string): boolean {
  return scopes.some(scope => {
    const depth = distance(scope.path, name);
    return depth >= 0 && depth <= (scope.kind === "tree" ? scope.depth! : 0);
  });
}
const snapshot = (): WatchSnapshot => ({ entries: new Map(), directories: new Map(), targets: new Map(), scanned: 0 });
const sorted = (changes: readonly WatchChange[] | undefined) => changes?.slice().sort((a, b) => a.path.localeCompare(b.path));

it("matches component-based selection for undecodable children and folded subtrees", () => {
  fc.assert(fc.property(fc.array(scope, { maxLength: 8 }), name, (scopes, directory) => {
    // Children hints stand for undecodable names, which cannot match a literal
    // scope component. This sentinel is outside the generated component alphabet.
    const child = directory ? directory + path.sep + "leaf" : "leaf";
    expect(selectedWatchChildren(scopes, directory)).toBe(selected(scopes, child));
    const intersects = selected(scopes, directory) || scopes.some(scope => distance(directory, scope.path) >= 0);
    expect(selectedWatchSubtree(scopes, directory)).toBe(intersects);
  }), { seed: 813, numRuns: 2000 });
});

it("reduces random native hint streams without inventing selected paths", () => {
  const hint = fc.record({ directory: name, name: fc.constantFrom("a", "b", "café", ".save-tmp"), event: fc.constantFrom("change" as const, "rename" as const) });
  fc.assert(fc.property(fc.array(scope, { maxLength: 8 }), fc.array(hint, { maxLength: 40 }), fc.integer({ min: 1, max: 8 }),
    (scopes, hints, limit) => {
      const before = snapshot();
      const reference = new Map<string, WatchChange>();
      for (const hint of hints) {
        const relative = path.join(hint.directory, hint.name);
        // No prior files: every admitted native hint is structural.
        for (const scope of scopes) {
          if (selected([scope], relative)) reference.set(relative, { path: relative, type: "structural" });
          else if (distance(relative, scope.path) > 0) reference.set(scope.path, { path: scope.path, type: "structural" });
        }
      }
      const actual = nativeChanges(scopes, before, { overflow: false, hints }, limit);
      expect(sorted(actual)).toEqual(reference.size > limit ? undefined : sorted([...reference.values()]));
    }), { seed: 783, numRuns: 1500 });
});

it("admits only observed names or explicit targets and preserves structural dominance", () => {
  const item = fc.record({ change, before: fc.boolean(), after: fc.boolean(), stable: fc.boolean() });
  fc.assert(fc.property(fc.array(scope, { maxLength: 4 }), fc.array(item, { maxLength: 25 }), fc.integer({ min: 1, max: 8 }),
    (scopes, items, limit) => {
      const before = snapshot(), after = snapshot();
      for (const item of items) {
        const name = item.change.path, parent = path.dirname(name) === "." ? "" : path.dirname(name);
        if (item.before) before.entries.set(name, "file:1:2:3");
        if (item.after) after.entries.set(name, "file:1:2:3");
        before.directories.set(parent, { dev: 1n, ino: 10n });
        after.directories.set(parent, { dev: 1n, ino: item.stable ? 10n : 11n });
      }
      const reference = new Map<string, WatchChange>();
      let uncertain = false;
      for (const { change } of items) {
        if (!before.entries.has(change.path) && !after.entries.has(change.path) && !scopes.some(scope => scope.path === change.path)) {
          const parent = path.dirname(change.path) === "." ? "" : path.dirname(change.path);
          if (before.directories.get(parent)!.ino !== after.directories.get(parent)!.ino) { uncertain = true; break; }
          continue;
        }
        if (!reference.has(change.path) && reference.size === limit) { uncertain = true; break; }
        reference.set(change.path, { ...change, type: reference.get(change.path)?.type === "structural" ? "structural" : change.type });
      }
      expect(sorted(guardedHintChanges(scopes, before, after, items.map(item => item.change), [], limit)))
        .toEqual(uncertain ? undefined : sorted([...reference.values()]));
    }), { seed: 773, numRuns: 1500 });
});
