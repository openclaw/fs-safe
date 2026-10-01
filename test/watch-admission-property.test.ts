import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, statSync } from "node:fs";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RootContext } from "../src/root-context.js";
import type { WatchSnapshot } from "../src/watch-scan.js";
import * as rootContext from "../src/root-context.js";
import * as listing from "../src/root-directory-list.js";
import * as entries from "../src/root-directory-entry.js";

const admissionSource = fileURLToPath(new URL("../src/watch-alias.ts", import.meta.url));
console.log("admission loader diagnostic", {
  cwd: process.cwd(), source: admissionSource, exists: existsSync(admissionSource),
  size: existsSync(admissionSource) ? statSync(admissionSource).size : undefined,
  candidates: readdirSync(path.dirname(admissionSource)).filter(name => name.startsWith("watch")),
});
const { admittedNativeChanges } = await vi.importActual<typeof import("../src/watch-alias.js")>(admissionSource);

const fake = { directories: new Map<string, bigint>(), entries: new Map<string, { ino: bigint; directory: boolean }>() };
const fakeRoot = Object.freeze({}) as RootContext;
beforeEach(() => {
  const original = {
    assertRoot: rootContext.assertRootIdentityCurrent, resolve: rootContext.resolvePathInRoot,
    createGuard: listing.createRootDirectoryObservationGuard, assertGuard: listing.assertRootDirectoryObservationGuard,
    lookup: entries.lookupRootDirectoryEntry,
  };
  vi.spyOn(rootContext, "assertRootIdentityCurrent").mockImplementation(async (...args) => {
    if (args[0] !== fakeRoot) await original.assertRoot(...args);
  });
  vi.spyOn(rootContext, "resolvePathInRoot").mockImplementation(async (...args) => {
    if (args[0] !== fakeRoot) return original.resolve(...args);
    return { resolved: args[1] === "." ? "" : args[1].slice(2) } as Awaited<ReturnType<typeof rootContext.resolvePathInRoot>>;
  });
  vi.spyOn(listing, "createRootDirectoryObservationGuard").mockImplementation(async (...args) => {
    if (args[0] !== fakeRoot) return original.createGuard(...args);
    const name = args[1];
    if (!fake.directories.has(name)) throw Object.assign(new Error("missing parent"), { code: "ENOENT" });
    return { realPath: name, stat: { dev: 1n, ino: fake.directories.get(name) } } as Awaited<ReturnType<typeof listing.createRootDirectoryObservationGuard>>;
  });
  vi.spyOn(listing, "assertRootDirectoryObservationGuard").mockImplementation(async (...args) => {
    if (args[0] !== fakeRoot) await original.assertGuard(...args);
  });
  vi.spyOn(entries, "lookupRootDirectoryEntry").mockImplementation(async (...args) => {
    if (args[0] !== fakeRoot) return original.lookup(...args);
    const [, guard, name] = args;
    const parent = guard.realPath === "ALIAS" ? "selected" : guard.realPath;
    const entry = fake.entries.get(parent ? path.join(parent, name) : name);
    return entry && { identity: { dev: 1n, ino: entry.ino }, entry: {
      name, isFile: !entry.directory, isDirectory: entry.directory, isSymbolicLink: false, nlink: 1,
    } } as Awaited<ReturnType<typeof entries.lookupRootDirectoryEntry>>;
  });
});
afterEach(() => { vi.restoreAllMocks(); });

it("never dismisses selected activity in random alias/folded streams with a fake Root", async () => {
  const hint = fc.record({ directory: fc.constantFrom("selected", "ALIAS", "unrelated"),
    event: fc.constantFrom("change" as const, "rename" as const, "children" as const, "subtree" as const),
    leaf: fc.constantFrom("file", "missing"),
  }).map(({ directory, event, leaf }) => ({ directory, event, name: event === "children" || event === "subtree" ? "" : leaf }));
  await fc.assert(fc.asyncProperty(fc.array(hint, { minLength: 1, maxLength: 25 }), fc.integer({ min: 1, max: 8 }), async (hints, limit) => {
    fake.directories = new Map([["", 1n], ["selected", 2n], ["ALIAS", 2n], ["unrelated", 4n]]);
    fake.entries = new Map([["selected", { ino: 2n, directory: true }], ["unrelated", { ino: 4n, directory: true }],
      [path.join("selected", "file"), { ino: 3n, directory: false }], [path.join("unrelated", "file"), { ino: 5n, directory: false }]]);
    const identity = (ino: bigint) => ({ dev: 1n, ino });
    const snapshot: WatchSnapshot = { scanned: 2,
      entries: new Map([["selected", "directory:1:2"], [path.join("selected", "file"), "file:1:3:1"]]),
      directories: new Map([["", identity(1n)], ["selected", identity(2n)]]),
      targets: new Map([["selected", identity(2n)]]),
      scopeAnchors: new Map([["selected", { directory: "", name: "selected", target: { ...identity(2n), kind: "directory" } }]]),
    };
    const scopes = [{ path: "selected", kind: "tree" as const, depth: 2 }];
    const result = await admittedNativeChanges(fakeRoot, scopes, snapshot, snapshot,
      { overflow: false, hints }, new AbortController().signal, limit, true);
    // The reference resolves identities independently of spelling. Coarse or
    // uncertain admission may ask for a full pass, but cannot return "unrelated".
    if (hints.some(hint => fake.directories.get(hint.directory) === 2n)) expect(result).not.toEqual([]);
    for (const change of result ?? []) {
      expect(change.path === "selected" || change.path.startsWith("selected" + path.sep)).toBe(true);
      expect(change.path.includes("ALIAS")).toBe(false);
    }
    const published = await admittedNativeChanges(fakeRoot, scopes, snapshot, snapshot,
      { overflow: false, hints }, new AbortController().signal, limit);
    if (hints.every(hint => hint.event === "subtree")) expect(published).toEqual([]);
    for (const change of published ?? []) expect(change.path.startsWith("ALIAS")).toBe(false);
  }), { seed: 774, numRuns: 1000 });
});
