import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { watchBinding } from "../src/watch-native.js";
const nativeWatchSupported = !!watchBinding("auto");
import { root } from "../src/root.js";
import { watch, type WatchInvalidation, type WatchSubscription } from "../src/watch.js";
let dir: string;
let owners: WatchSubscription[];
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-watch-alias-")); owners = []; });
afterEach(async () => { await Promise.allSettled(owners.map(owner => owner.close())); await fs.rm(dir, { recursive: true, force: true }); });

describe.each(["events", "poll"] as const)("filesystem scope spelling (%s)", mode => {
  it.skipIf(mode === "events" && !nativeWatchSupported)("uses real filesystem lookup for exact entries and prefix scopes", async () => {
    await fs.mkdir(path.join(dir, "MixedDir"));
    await fs.writeFile(path.join(dir, "MixedDir/Entry.TXT"), "before");
    const actual = await fs.lstat(path.join(dir, "MixedDir/Entry.TXT"), { bigint: true });
    const alias = await fs.lstat(path.join(dir, "mixeddir/entry.txt"), { bigint: true }).catch(() => undefined);
    const aliases = alias?.dev === actual.dev && alias?.ino === actual.ino;
    const hints: WatchInvalidation[] = [];
    const entry = watch(await root(dir), { mode, scopes: [{ path: path.join("mixeddir", "entry.txt"), kind: "entry" }], onInvalidate: hint => { hints.push(hint); } }); owners.push(entry);
    const tree = watch(await root(dir), { mode, scopes: [{ path: "mixeddir", kind: "tree" }], onInvalidate() {} }); owners.push(tree);
    await Promise.all([entry.ready, tree.ready]);
    expect(entry.health().directories).toBe(aliases ? 2 : 1);
    expect(tree.health().directories).toBe(aliases ? 2 : 1);
    hints.length = 0;
    await fs.writeFile(path.join(dir, "MixedDir/Entry.TXT"), "actual edit");
    await entry.reconcile();
    if (aliases) await expect((await root(dir)).readText("mixeddir/entry.txt")).resolves.toBe("actual edit");
    if (aliases) {
      expect(hints.some(hint => hint.changes === undefined || hint.changes.some(change => change.path === path.join("mixeddir", "entry.txt")))).toBe(true);
    } else {
      expect(hints.every(hint => hint.reason === "overflow" && hint.changes === undefined)).toBe(true);
      await fs.mkdir(path.join(dir, "mixeddir"));
      await fs.writeFile(path.join(dir, "mixeddir/entry.txt"), "distinct selected file");
      await Promise.all([entry.reconcile(), tree.reconcile()]);
      expect(entry.health().directories).toBe(2);
      expect(await (await root(dir)).readText("mixeddir/entry.txt")).toBe("distinct selected file");
      expect(await fs.readFile(path.join(dir, "MixedDir/Entry.TXT"), "utf8")).toBe("actual edit");
    }
  });
});
