import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchDirty, type WatchScope, type WatchSubscription } from "../src/watch.js";

let dir: string;
const owners: WatchSubscription[] = [];
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-watch-scopes-")); });
afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map(owner => owner.close()));
  await fs.rm(dir, { recursive: true, force: true });
});
async function observe(scope: WatchScope) {
  const hints: WatchDirty[] = [];
  const owner = watch(await root(dir), {
    mode: "poll", intervalMs: 60_000, scopes: [scope], onDirty: hint => { hints.push(hint); },
  });
  owners.push(owner);
  await owner.ready;
  return { owner, hints };
}

const rootScopes: WatchScope[] = [
  { path: "", kind: "entry" },
  { path: "", kind: "tree", depth: 0 },
  { path: "", kind: "tree", depth: 2 },
];
it.skipIf(process.platform === "win32").each(rootScopes)("observes Root mode changes for %j", async scope => {
  await fs.chmod(dir, 0o700);
  const { owner, hints } = await observe(scope);
  hints.length = 0;
  await fs.chmod(dir, 0o750);
  await owner.reconcile();
  expect(hints).toHaveLength(1);
  expect(hints[0]).toMatchObject({ reason: "reconcile", changes: [{ path: "", type: "structural" }] });
  hints.length = 0;
  await owner.reconcile();
  expect(hints).toEqual([]);
});

it.each(rootScopes)("does not report child-only Root metadata as an entry change for %j", async scope => {
  const { owner, hints } = await observe(scope);
  hints.length = 0;
  await fs.writeFile(path.join(dir, "child"), "new child");
  // Make the directory mtime change deterministic even on coarse-resolution filesystems.
  await fs.utimes(dir, new Date(0), new Date(0));
  await owner.reconcile();
  if (scope.kind === "tree" && scope.depth! > 0) {
    expect(hints).toHaveLength(1);
    expect(hints[0]?.changes).toEqual([{ path: "child", type: "structural" }]);
  } else expect(hints).toEqual([]);
});

const spellings = [
  ["./", ""], [".//", ""], ["child/", "child"], ["./child//./", "child"],
  ["child/nested/", path.join("child", "nested")],
  ...(process.platform === "win32" ? [[".\\", ""], ["child\\", "child"], ["child\\nested/\\", "child\\nested"]] : []),
];
it.each(spellings)("admits trailing separator scope %s as %s", async (supplied, normalized) => {
  await fs.mkdir(path.join(dir, "child/nested"), { recursive: true });
  for (const kind of ["entry", "tree"] as const) {
    const { owner, hints } = await observe({ path: supplied!, kind });
    expect(hints[0]?.scopes).toEqual([{ path: normalized, kind, depth: 32 }]);
    hints.length = 0;
    await owner.update([{ path: supplied!, kind }]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({ reason: "reconcile", scopes: [{ path: normalized, kind, depth: 32 }] });
    await owner.close();
  }
});

it.skipIf(process.platform === "win32")("keeps a POSIX trailing backslash as a literal filename", async () => {
  await fs.mkdir(path.join(dir, "child\\"));
  const { owner, hints } = await observe({ path: "child\\/", kind: "tree" });
  expect(hints[0]?.scopes[0]?.path).toBe("child\\");
  hints.length = 0;
  await fs.writeFile(path.join(dir, "child\\", "entry"), "selected");
  await owner.reconcile();
  expect(hints[0]?.changes).toEqual([{ path: "child\\/entry", type: "structural" }]);
});

it.each(["../", "child/../", "/child/", "child/\0/"])("rejects invalid scope before canonicalizing %j", async supplied => {
  const admitted = await root(dir);
  expect(() => watch(admitted, { mode: "poll", scopes: [{ path: supplied, kind: "tree" }], onDirty() {} })).toThrow();
});
