import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { root } from "../src/root.js";
import { watch, type WatchDirty, type WatchSubscription } from "../src/watch.js";
import { resolveWindowsSystemCommand } from "../src/windows-command.js";
let dir: string;
let owners: WatchSubscription[];
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-watch-alias-")); owners = []; });
afterEach(async () => { await Promise.allSettled(owners.map(owner => owner.close())); await fs.rm(dir, { recursive: true, force: true }); });

describe.each(["node", "poll"] as const)("filesystem scope spelling (%s)", mode => {
  it("uses real filesystem lookup for exact entries and prefix scopes", async () => {
    await fs.mkdir(path.join(dir, "MixedDir"));
    await fs.writeFile(path.join(dir, "MixedDir/Entry.TXT"), "before");
    const actual = await fs.lstat(path.join(dir, "MixedDir/Entry.TXT"), { bigint: true });
    const alias = await fs.lstat(path.join(dir, "mixeddir/entry.txt"), { bigint: true }).catch(() => undefined);
    const aliases = alias?.dev === actual.dev && alias?.ino === actual.ino;
    const hints: WatchDirty[] = [];
    const entry = watch(await root(dir), { mode, scopes: [{ path: path.join("mixeddir", "entry.txt"), kind: "entry" }], onDirty: hint => { hints.push(hint); } }); owners.push(entry);
    const tree = watch(await root(dir), { mode, scopes: [{ path: "mixeddir", kind: "tree" }], onDirty() {} }); owners.push(tree);
    await Promise.all([entry.ready, tree.ready]);
    expect(entry.health().observedDirectories).toBe(aliases ? 2 : 1);
    expect(tree.health().observedDirectories).toBe(aliases ? 2 : 1);
    hints.length = 0;
    await fs.writeFile(path.join(dir, "MixedDir/Entry.TXT"), "actual edit");
    if (aliases && mode === "node") {
      await expect.poll(() => hints.some(hint => hint.changes === undefined
        || hint.changes.some(change => change.path === path.join("mixeddir", "entry.txt")))).toBe(true);
      await expect((await root(dir)).readText("mixeddir/entry.txt")).resolves.toBe("actual edit");
    } else await entry.reconcile();
    if (aliases) {
      expect(hints.some(hint => hint.changes === undefined || hint.changes.some(change => change.path === path.join("mixeddir", "entry.txt")))).toBe(true);
    } else {
      expect(hints).toEqual([]);
      await fs.mkdir(path.join(dir, "mixeddir"));
      await fs.writeFile(path.join(dir, "mixeddir/entry.txt"), "distinct selected file");
      await Promise.all([entry.reconcile(), tree.reconcile()]);
      expect(entry.health().observedDirectories).toBe(2);
      expect(await (await root(dir)).readText("mixeddir/entry.txt")).toBe("distinct selected file");
      expect(await fs.readFile(path.join(dir, "MixedDir/Entry.TXT"), "utf8")).toBe("actual edit");
    }
  });
});

it.skipIf(process.platform !== "win32")("does not merge case-distinct entries on case-sensitive Windows", async () => {
  const enabled = spawnSync(resolveWindowsSystemCommand("fsutil.exe"), ["file", "setCaseSensitiveInfo", dir, "enable"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  expect(enabled.error).toBeUndefined();
  expect(enabled.status, "Windows proof requires a case-sensitive fixture directory: " + enabled.stderr).toBe(0);
  await fs.writeFile(path.join(dir, "entry"), "selected");
  await fs.writeFile(path.join(dir, "ENTRY"), "distinct");
  const hints: WatchDirty[] = [];
  const owner = watch(await root(dir), { scopes: [{ path: "entry", kind: "entry" }], onDirty: hint => { hints.push(hint); } }); owners.push(owner);
  await owner.ready; hints.length = 0;
  await fs.writeFile(path.join(dir, "ENTRY"), "other edit");
  await owner.reconcile();
  expect(hints).toEqual([]);
  await fs.writeFile(path.join(dir, "entry"), "selected edit");
  await owner.reconcile();
  expect(hints.some(hint => hint.changes?.some(change => change.path === "entry"))).toBe(true);
}, 20_000);

it.skipIf(process.platform !== "win32")("observes an exact Windows short-name alias without lexical hint loss", async () => {
  const long = path.join(dir, "LongFileNameForWatch.txt");
  await fs.writeFile(long, "before");
  const assigned = spawnSync(resolveWindowsSystemCommand("fsutil.exe"), ["file", "setshortname", long, "WATCH~1.TXT"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  expect(assigned.error).toBeUndefined();
  expect(assigned.status, "Windows proof requires a fixture short-name alias: " + assigned.stderr).toBe(0);
  const expected = await fs.lstat(long, { bigint: true });
  const short = await fs.lstat(path.join(dir, "WATCH~1.TXT"), { bigint: true });
  expect([short.dev, short.ino]).toEqual([expected.dev, expected.ino]);
  const hints: WatchDirty[] = [];
  const owner = watch(await root(dir), { scopes: [{ path: "WATCH~1.TXT", kind: "entry" }], onDirty: hint => { hints.push(hint); } }); owners.push(owner);
  await owner.ready; hints.length = 0;
  await fs.writeFile(long, "later real edit");
  await expect.poll(() => hints.length).toBeGreaterThan(0);
  expect(hints.some(hint => hint.changes?.some(change => change.path === "WATCH~1.TXT"))).toBe(true);
}, 20_000);
