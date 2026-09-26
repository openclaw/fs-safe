import fs from "node:fs/promises";
import fsSync from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchInvalidation, type WatchOptions, type WatchScope, type WatchSubscription } from "../src/watch.js";
import { watchBinding } from "../src/watch-native.js";

const windows = process.platform === "win32";
const binding = windows ? watchBinding("auto") : undefined;
if (windows && process.env.FS_SAFE_TEST_WATCH_EVENTS === "1" && !binding) {
  throw new Error("Windows edge coverage requires the source-built watch binding");
}
const tree = [{ path: "", kind: "tree" as const }];
let directory: string;
let owners: WatchSubscription[];

describe.skipIf(!windows || !binding)("Windows watch boundary cases", () => {
  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watch-win-edge-")));
    owners = [];
  });
  afterEach(async () => {
    await Promise.all(owners.map(owner => owner.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function observe(location = directory, scopes: readonly WatchScope[] = tree, exclude?: WatchOptions["exclude"]) {
    const invalidations: WatchInvalidation[] = [];
    const owner = watch(await root(location), {
      mode: "events", scopes, intervalMs: 60_000, exclude,
      onInvalidate: value => { invalidations.push(value); },
    });
    owners.push(owner);
    await owner.ready;
    expect(owner.health().mode).toBe("events");
    invalidations.length = 0;
    return { owner, invalidations };
  }
  const details = (values: WatchInvalidation[]) => values.flatMap(value => value.changes ?? []);

  it.each(["watched tree", "anchor ancestor"])("allows recursive deletion of %s while observation remains open", async which => {
    await fs.mkdir(path.join(directory, "parent/anchor/child"), { recursive: true });
    await fs.writeFile(path.join(directory, "parent/anchor/child/file.txt"), "data");
    const { owner, invalidations } = await observe(directory, [{ path: "parent/anchor", kind: "tree" }]);
    const deleted = path.join(directory, which === "watched tree" ? "parent/anchor" : "parent");
    await fs.rm(deleted, { recursive: true });
    await owner.reconcile();
    expect(owner.health()).toMatchObject({ state: "ready", directories: which === "watched tree" ? 2 : 1 });
    await expect(fs.lstat(deleted)).rejects.toMatchObject({ code: "ENOENT" });
    // Recreating the exact name proves no watch handle leaves it delete-pending.
    await fs.mkdir(deleted);
    expect(invalidations.length).toBeGreaterThan(0);
  });

  it("does not adopt a renamed Root", async () => {
    const parent = path.join(directory, "parent");
    const location = path.join(parent, "authority");
    await fs.mkdir(location, { recursive: true });
    const { owner, invalidations } = await observe(location);
    const to = location + "-renamed";
    // Keep the rename, replacement and hostile write ahead of JS hint delivery.
    fsSync.renameSync(location, to);
    fsSync.mkdirSync(location, { recursive: true });
    fsSync.writeFileSync(path.join(location, "outside-sentinel.txt"), "outside");
    fsSync.writeFileSync(path.join(to, "relocated-sentinel.txt"), "moved");
    await expect(owner.reconcile()).rejects.toMatchObject({ code: "path-mismatch" });
    expect(owner.health()).toMatchObject({ state: "unavailable" });
    expect(invalidations).toEqual([]);
    await owner.close();
  });

  it("allows renaming a directory containing watched scopes inside the Root", async () => {
    await fs.mkdir(path.join(directory, "parent/anchor/deep"), { recursive: true });
    await fs.writeFile(path.join(directory, "parent/anchor/deep/file.txt"), "before");
    const scopes: WatchScope[] = [{ path: "parent/anchor", kind: "tree" }];
    const { owner, invalidations } = await observe(directory, scopes);
    // A second owner must neither pin descendants nor lose delivery when its peer closes.
    const peer = await observe(directory, scopes);
    await fs.rename(path.join(directory, "parent"), path.join(directory, "moved"));
    await owner.reconcile();
    expect(owner.health()).toMatchObject({ state: "ready", directories: 1 });
    expect(invalidations.length).toBeGreaterThan(0);
    await owner.close();
    await peer.owner.reconcile();
    peer.invalidations.length = 0;
    await fs.mkdir(path.join(directory, "parent/anchor"), { recursive: true });
    await fs.writeFile(path.join(directory, "parent/anchor/new.txt"), "replacement");
    await expect.poll(() => peer.invalidations.length, { timeout: 2000 }).toBeGreaterThan(0);
    await peer.owner.reconcile();
    expect(peer.owner.health()).toMatchObject({ state: "ready", mode: "events", directories: 3 });
    expect(await fs.readFile(path.join(directory, "moved/anchor/deep/file.txt"), "utf8")).toBe("before");
  });

  it("documents the Root-ancestor rename restriction and polling escape hatch", async () => {
    const parent = path.join(directory, "parent"), location = path.join(parent, "authority");
    await fs.mkdir(location, { recursive: true });
    const { owner } = await observe(location);
    const destination = parent + "-moved";
    await expect(fs.rename(parent, destination)).rejects.toMatchObject({ code: "EPERM" });
    await owner.reconcile();
    expect(owner.health().state).toBe("ready");
    await owner.close();
    const polling = watch(await root(location), { mode: "poll", scopes: tree, intervalMs: 60_000, onInvalidate() {} });
    owners.push(polling);
    await polling.ready;
    await fs.rename(parent, destination);
    await expect(polling.reconcile()).rejects.toMatchObject({ code: "path-mismatch" });
    expect(polling.health().state).toBe("unavailable");
  });

  it("reconciles a case-only rename without duplicate paths or ghost entries", async () => {
    await fs.writeFile(path.join(directory, "foo.txt"), "data");
    const scanned = new Set<string>();
    const { owner, invalidations } = await observe(directory, tree, entry => { scanned.add(entry.path); return false; });
    await fs.rename(path.join(directory, "foo.txt"), path.join(directory, "Foo.txt"));
    await expect.poll(() => invalidations.length, { timeout: 2000 }).toBeGreaterThan(0);
    for (const invalidation of invalidations) {
      const paths = (invalidation.changes ?? []).map(change => change.path);
      expect(new Set(paths).size).toBe(paths.length);
    }
    expect(details(invalidations).every(change => ["foo.txt", "Foo.txt"].includes(change.path) && change.type === "structural")).toBe(true);
    expect(await fs.readdir(directory)).toEqual(["Foo.txt"]);
    scanned.clear();
    await owner.reconcile();
    expect([...scanned]).toEqual(["Foo.txt"]);
    expect(owner.health().state).toBe("ready");
  });

  it("admits an actual 8.3 scope alias by identity and accepts writes through either spelling", async context => {
    const long = path.join(directory, "Long Directory Name");
    await fs.mkdir(long);
    const short = execFileSync("cmd.exe", ["/d", "/c", `for %I in ("${long}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).trim();
    expect(path.isAbsolute(short)).toBe(true);
    expect((await fs.stat(short, { bigint: true })).ino).toBe((await fs.stat(long, { bigint: true })).ino);
    if (short === long || !path.basename(short).includes("~")) {
      if (process.env.FS_SAFE_WINDOWS_REQUIRE_SHORT_NAMES === "1") throw new Error("8.3 fixture alias was not created");
      context.skip("test volume has 8.3 creation disabled");
      return;
    }
    const alias = path.basename(short);
    const { owner, invalidations } = await observe(directory, [{ path: alias, kind: "tree" }]);
    const reported = new Set<string>();
    for (const [spelling, name] of [[long, "long-write.txt"], [short, "short-write.txt"]] as const) {
      invalidations.length = 0;
      await fs.writeFile(path.join(spelling, name), "data");
      await expect.poll(() => invalidations.some(value => !value.changes || value.changes.some(change => change.path === path.join(alias, name))), { timeout: 2000 }).toBe(true);
      await owner.reconcile();
      // A tree scope includes its entry as well as its descendants.
      expect(details(invalidations).filter(change => change.path !== alias && !change.path.startsWith(alias + path.sep))).toEqual([]);
      for (const change of details(invalidations)) reported.add(change.path);
    }
    expect(await fs.readdir(long)).toEqual(["long-write.txt", "short-write.txt"]);
    console.log(JSON.stringify({ proof: "windows-short-name-scope", alias, reported: [...reported] }));
  });

  it("observes paths beyond MAX_PATH", async () => {
    const relative = Array.from({ length: 7 }, (_, index) => `segment-${index}-` + "x".repeat(35)).join(path.sep);
    const deep = path.join(directory, relative);
    expect(deep.length).toBeGreaterThan(260);
    await fs.mkdir(deep, { recursive: true });
    const { owner, invalidations } = await observe();
    await fs.writeFile(path.join(deep, "long.txt"), "data");
    await expect.poll(() => invalidations.some(value => !value.changes || value.changes.some(change => change.path === path.join(relative, "long.txt"))), { timeout: 2000 }).toBe(true);
    await owner.reconcile();
    expect(owner.health().state).toBe("ready");
  });

  it.each(["junction", "dir"] as const)("observes a %s reparse entry without following it", async (type, context) => {
    const inside = path.join(directory, "inside"), outside = path.join(directory, "outside");
    await fs.mkdir(inside); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "outside-sentinel.txt"), "private");
    const scanned = new Set<string>();
    const { owner, invalidations } = await observe(inside, tree, entry => { scanned.add(`${entry.kind}:${entry.path}`); return false; });
    try { await fs.symlink(outside, path.join(inside, "link"), type); }
    catch (error) {
      if (type !== "dir" || (error as NodeJS.ErrnoException).code !== "EPERM" || process.env.FS_SAFE_WINDOWS_REQUIRE_SYMLINKS === "1") throw error;
      context.skip("Windows account cannot create directory symlinks");
      return;
    }
    await owner.reconcile();
    expect(invalidations.some(value => !value.changes || value.changes.some(change => change.path === "link" && change.type === "structural"))).toBe(true);
    expect([...scanned]).toEqual(["symlink:link"]);
    expect(owner.health().directories).toBe(1);
    await fs.writeFile(path.join(outside, "outside-sentinel.txt"), "changed");
    await new Promise(resolve => setTimeout(resolve, 100));
    await owner.reconcile();
    expect(details(invalidations).every(change => change.path === "link")).toBe(true);
  });

  it("does not leak outside names after a watched directory is replaced by a junction", async () => {
    const inside = path.join(directory, "inside"), outside = path.join(directory, "outside");
    await fs.mkdir(path.join(inside, "watched"), { recursive: true }); await fs.mkdir(outside);
    const { owner, invalidations } = await observe(inside, [{ path: "watched", kind: "tree" }]);
    fsSync.renameSync(path.join(inside, "watched"), path.join(directory, "retired"));
    fsSync.symlinkSync(outside, path.join(inside, "watched"), "junction");
    fsSync.writeFileSync(path.join(outside, "outside-sentinel.txt"), "private");
    fsSync.writeFileSync(path.join(directory, "retired/retired-sentinel.txt"), "private");
    await new Promise(resolve => setTimeout(resolve, 100));
    await owner.reconcile();
    expect(owner.health()).toMatchObject({ state: "ready", directories: 1 });
    expect(details(invalidations).every(change => change.path === "watched")).toBe(true);
    expect(JSON.stringify(invalidations)).not.toContain("sentinel");
  });

  it("never admits alternate data stream names", async () => {
    const file = path.join(directory, "file.txt");
    await fs.writeFile(file, "ordinary data");
    const { owner, invalidations } = await observe();
    await fs.writeFile(file + ":stream", "stream data");
    await new Promise(resolve => setTimeout(resolve, 100));
    await owner.reconcile();
    expect(await fs.readFile(file, "utf8")).toBe("ordinary data");
    expect(await fs.readFile(file + ":stream", "utf8")).toBe("stream data");
    expect(details(invalidations).every(change => change.path === "file.txt" && change.type === "content")).toBe(true);
    expect(JSON.stringify(invalidations)).not.toContain(":stream");
  });
});
