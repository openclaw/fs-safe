import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchDirty, type WatchSubscription } from "../src/watch.js";
import { nativeWatchSupported } from "../src/watch-node.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";

let dir: string;
const owners: WatchSubscription[] = [];
beforeEach(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "fs-safe-watch-"));
  dir = (await root(temporary)).rootReal;
});
afterEach(async () => {
  __setFsSafeTestHooksForTest();
  await Promise.allSettled(owners.splice(0).map(owner => owner.close()));
  await fs.rm(dir, { recursive: true, force: true });
});
function own(owner: WatchSubscription) { owners.push(owner); return owner; }
const scopes = [{ path: "tree", kind: "tree" as const }];
const portableMode = nativeWatchSupported ? "node" : "poll";

describe.each(["node", "poll"] as const)("watch %s", mode => {
  const modeIt = it.skipIf(mode === "node" && !nativeWatchSupported);
  modeIt.each([0, 1, 2])("recovers missing descendants and observes later edits (fresh owner %s)", async () => {
    const hints: WatchDirty[] = [];
    const admitted = await root(dir);
    let backends = 0;
    __setFsSafeTestHooksForTest({ afterWatchBackendCreated: () => { backends++; } });
    const owner = own(watch(admitted, { scopes: [{ path: "a/b/tree", kind: "tree" }], mode, onDirty: hint => { hints.push(hint); } }));
    await owner.ready;
    expect(owner.health().state).toBe("ready");
    await fs.mkdir(path.join(dir, "a/b/tree"), { recursive: true });
    await fs.writeFile(path.join(dir, "a/b/tree/skill.md"), "first");
    await owner.reconcile();
    expect(owner.health().observedDirectories).toBe(4);
    for (let cycle = 0; cycle < 3; cycle++) {
      await fs.rename(path.join(dir, "a"), path.join(dir, "old" + cycle));
      await owner.reconcile();
      expect(owner.health().observedDirectories).toBe(1);
      await fs.mkdir(path.join(dir, "a/b/tree"), { recursive: true });
      await owner.reconcile();
      expect(owner.health().observedDirectories).toBe(4);
      if (mode === "node" && (process.platform === "darwin" || process.platform === "win32")) {
        expect(owner.health().directories).toBe(1);
        expect(backends).toBe(1); // Virtual descendant churn must not restart the native Root stream.
      }
      const count = hints.length;
      await fs.writeFile(path.join(dir, "a/b/tree/skill.md"), "later edit " + cycle);
      if (mode === "poll") await owner.reconcile();
      else await expect.poll(() => hints.length).toBeGreaterThan(count);
      expect(hints.length).toBeGreaterThan(count);
      await expect(admitted.readText("a/b/tree/skill.md")).resolves.toBe("later edit " + cycle);
    }
    await owner.close();
    expect(owner.health()).toMatchObject({ state: "closed", directories: 0, workers: 0 });
  });
  modeIt("never repins a replacement authority Root", async () => {
    const admitted = path.join(dir, "authority");
    await fs.mkdir(admitted);
    const owner = own(watch(await root(admitted), { mode, scopes: [{ path: "", kind: "tree" }], onDirty() {} }));
    await owner.ready;
    await fs.rename(admitted, path.join(dir, "old"));
    await fs.mkdir(admitted);
    await expect(owner.reconcile()).rejects.toMatchObject({ code: "path-mismatch" });
    expect(owner.health().state).toBe("unavailable");
    await expect(owner.close()).resolves.toBeUndefined();
    expect(owner.health().error).toMatchObject({ code: "path-mismatch" });
  });
  modeIt("uses directory-only registrations and respects depth/exclusions", async () => {
    await fs.mkdir(path.join(dir, "tree/child/deep"), { recursive: true });
    await fs.mkdir(path.join(dir, "tree/ignored"));
    await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(dir, "tree", String(i)), "x")));
    const owner = own(watch(await root(dir), { mode, scopes: [{ path: "tree", kind: "tree", depth: 2 }], exclude: entry => entry.path.endsWith("ignored"), onDirty() {} }));
    await owner.ready;
    expect(owner.health().observedDirectories).toBe(3);
    expect(owner.health().directories).toBe(mode === "node" ? (["win32", "darwin"].includes(process.platform) ? 1 : 3) : 0);
    expect(owner.health().workers).toBe(mode === "node" ? 1 : 0);
    expect(owner.health().scannedEntries).toBeGreaterThan(100);
  });
  modeIt("rejects partial admission when the entry budget is exhausted", async () => {
    await fs.writeFile(path.join(dir, "one"), "1");
    await fs.writeFile(path.join(dir, "two"), "2");
    const owner = own(watch(await root(dir), { mode, scopes: [{ path: "", kind: "tree" }], maxEntries: 1, onDirty() {} }));
    await expect(owner.ready).rejects.toMatchObject({ code: "too-large" });
    expect(owner.health().state).toBe("unavailable");
    expect(owner.health().failure?.operation).toBe("scan");
    await expect(owner.close()).resolves.toBeUndefined();
    expect(owner.health().error).toMatchObject({ code: "too-large" });
  });
  modeIt("observes symlink entries without adopting their targets", async () => {
    await fs.mkdir(path.join(dir, "target"));
    await fs.symlink(path.join(dir, "target"), path.join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
    const owner = own(watch(await root(dir), { mode, scopes: [{ path: "link", kind: "tree" }], onDirty() {} }));
    await owner.ready;
    expect(owner.health().observedDirectories).toBe(1);
    const invalid = own(watch(await root(dir), { mode, scopes: [{ path: "link/file", kind: "entry" }], onDirty() {} }));
    await expect(invalid.ready).rejects.toMatchObject({ code: "symlink" });
  });
  modeIt("keeps literal tilde names and rejects escaping scope inputs", async () => {
    await fs.mkdir(path.join(dir, "~"));
    const admitted = await root(dir);
    const owner = own(watch(admitted, { mode, scopes: [{ path: "~", kind: "tree" }], onDirty() {} }));
    await owner.ready;
    expect(owner.health().observedDirectories).toBe(2);
    expect(() => watch(admitted, { mode, scopes: [{ path: "../escape", kind: "tree" }], onDirty() {} })).toThrow();
  });
});

it("joins a held scan and prevents late acquisition when close races startup", async () => {
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  __setFsSafeTestHooksForTest({ beforeWatchRegistration: async () => { entered(); await held; } });
  const owner = own(watch(await root(dir), { mode: portableMode, scopes, onDirty() {} }));
  await barrier;
  let closed = false;
  const closing = owner.close().then(() => { closed = true; });
  expect(owner.close()).toBe(owner.close());
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await closing;
  await expect(owner.ready).rejects.toMatchObject({ name: "AbortError" });
  expect(owner.health()).toMatchObject({ directories: 0, workers: 0, state: "closed" });
});
it("permits synchronous retirement during initial dirty publication", async () => {
  const admitted = await root(dir);
  let owner!: WatchSubscription;
  owner = own(watch(admitted, { mode: portableMode, scopes, onDirty() { void owner.close(); } }));
  await expect(owner.ready).rejects.toMatchObject({ name: "AbortError" });
  await owner.close();
  expect(owner.health().state).toBe("closed");
});
it("fences superseded target updates, including the readiness microtask", async () => {
  const hints: WatchDirty[] = [];
  const owner = own(watch(await root(dir), { mode: portableMode, scopes, onDirty: hint => { hints.push(hint); } }));
  await owner.ready;
  const superseded = owner.update([{ path: "old", kind: "tree" }]);
  const latest = owner.update([{ path: "new", kind: "tree" }]);
  await expect(superseded).rejects.toMatchObject({ name: "AbortError" });
  await latest;
  expect(owner.health()).toMatchObject({ generation: 3, state: "ready" });
  expect(hints.at(-1)?.generation).toBe(3);
  await owner.close();
  await expect(owner.update(scopes)).rejects.toMatchObject({ name: "AbortError" });
});
it.skipIf(!nativeWatchSupported)("delivers real edits without explicit reconciliation", async () => {
  await fs.mkdir(path.join(dir, "tree"));
  const hints: WatchDirty[] = [];
  const admitted = await root(dir);
  const owner = own(watch(admitted, { scopes, onDirty: hint => { hints.push(hint); } }));
  await owner.ready;
  hints.length = 0;
  await fs.writeFile(path.join(dir, "tree/skill.md"), "real event");
  // Coalesced/native-unknown filenames legitimately invalidate the whole scope.
  // Still require a timely relevant hint, with no manual scan or longer budget.
  await expect.poll(() => hints.some(hint => hint.changes === undefined
    ? hint.scopes.some(scope => scope.path === "tree")
    : hint.changes.some(change => change.path === path.join("tree", "skill.md")))).toBe(true);
  await expect(admitted.readText("tree/skill.md")).resolves.toBe("real event");
  expect(owner.health().pendingInvalidations).toBeLessThanOrEqual(1);
});


it("does not treat children of an exact directory entry as selected changes", async () => {
  await fs.mkdir(path.join(dir, "rejected-include"));
  const hints: WatchDirty[] = [];
  const owner = own(watch(await root(dir), { mode: "poll", scopes: [{ path: "rejected-include", kind: "entry" }], onDirty: hint => { hints.push(hint); } }));
  await owner.ready;
  hints.length = 0;
  await fs.writeFile(path.join(dir, "rejected-include", "child"), "not a config event");
  await owner.reconcile();
  expect(hints).toEqual([]);
  await fs.rename(path.join(dir, "rejected-include"), path.join(dir, "old-include"));
  await fs.mkdir(path.join(dir, "rejected-include"));
  await owner.reconcile();
  expect(hints.at(-1)?.changes).toEqual([{ path: "rejected-include", type: "structural" }]);
});


it.skipIf(!nativeWatchSupported)("does not publish filenames from a watched directory moved outside its Root", async () => {
  const authority = path.join(dir, "authority");
  await fs.mkdir(path.join(authority, "tree"), { recursive: true });
  const hints: WatchDirty[] = [];
  const owner = own(watch(await root(authority), { scopes, onDirty: hint => { hints.push(hint); } }));
  await owner.ready;
  hints.length = 0;
  await fs.rename(path.join(authority, "tree"), path.join(dir, "outside"));
  await fs.writeFile(path.join(dir, "outside", "outside-secret-name"), "outside");
  await expect.poll(() => hints.length).toBeGreaterThan(0);
  await owner.reconcile();
  expect(hints.flatMap(hint => hint.changes?.map(change => change.path) ?? [])).not.toContain(path.join("tree", "outside-secret-name"));
});


it.skipIf(!nativeWatchSupported)("quarantines raw filenames after a registration swap-and-restore", async () => {
  const authority = path.join(dir, "authority");
  const watched = path.join(authority, "tree");
  const saved = path.join(authority, "saved");
  const outside = path.join(dir, "outside");
  await fs.mkdir(watched, { recursive: true });
  await fs.mkdir(outside);
  let swapped = false;
  let restored = false;
  let inject: ((batch: { hints: Array<{ directory: string; name: string | null; event: string }>; overflow: boolean }) => void) | undefined;
  __setFsSafeTestHooksForTest({
    afterWatchBackendCreated: (_root, emit) => { inject = emit; },
    beforeWatchRegistration: async name => {
      if (name !== watched || swapped) return;
      swapped = true;
      await fs.rename(watched, saved);
      await fs.symlink(outside, watched, process.platform === "win32" ? "junction" : "dir");
    },
    afterWatchRegistration: async name => {
      if (name !== watched || restored) return;
      restored = true;
      await fs.unlink(watched);
      await fs.rename(saved, watched);
    },
  });
  const hints: WatchDirty[] = [];
  const admitted = await root(authority);
  const owner = own(watch(admitted, { scopes, onDirty: hint => { hints.push(hint); } }));
  await owner.ready;
  expect(swapped).toBe(true);
  expect(restored).toBe(true);
  hints.length = 0;
  await fs.writeFile(path.join(outside, "private-outside-name"), "outside");
  // Linux descriptor binding must prevent the old outside-inode misbinding.
  // This bounded negative window is not a startup delay for any positive test.
  if (process.platform === "linux") {
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(hints).toEqual([]);
  }
  // Separately exercise publication defense against an injected stale payload;
  // injection is not evidence that a real outside edit reached this observer.
  expect(inject).toBeTypeOf("function");
  const beforeInjection = hints.length;
  inject!({ overflow: false, hints: [{ directory: "tree", name: "private-outside-name", event: "rename" }] });
  await expect.poll(() => hints.length).toBeGreaterThan(beforeInjection);
  expect(hints.flatMap(hint => hint.changes?.map(change => change.path) ?? [])).not.toContain(path.join("tree", "private-outside-name"));
  // Swap/restore can leave a physical registration on the wrong inode without
  // changing guarded path identities. Explicitly retire/reacquire before testing
  // a later native edit; no injected hint or post-edit scan may satisfy it.
  await owner.update(scopes);
  const beforeAdmittedEdit = hints.length;
  await fs.writeFile(path.join(watched, "admitted-name"), "inside");
  await expect.poll(() => hints.slice(beforeAdmittedEdit).some(hint => hint.changes === undefined
    ? hint.scopes.some(scope => scope.path === "tree")
    : hint.changes.some(change => change.path === path.join("tree", "admitted-name")))).toBe(true);
  await expect(admitted.readText("tree/admitted-name")).resolves.toBe("inside");
  expect(hints.flatMap(hint => hint.changes?.map(change => change.path) ?? [])).not.toContain(path.join("tree", "private-outside-name"));
});
