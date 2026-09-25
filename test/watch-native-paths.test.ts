import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { nativeWatchSupported } from "../src/watch-node.js";
import { root } from "../src/root.js";
import { watch, type WatchDirty, type WatchSubscription } from "../src/watch.js";

let dir: string;
let owner: WatchSubscription | undefined;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "fs-watch-native-path-")); owner = undefined; });
afterEach(async () => { await owner?.close(); await fs.rm(dir, { recursive: true, force: true }); });

for (const name of ["deep/nested/file", "deep/nested/é.md", "literal\\directory:part/nested/file:part"]) {
  it.skipIf(!nativeWatchSupported)("observes native same-metadata edit: " + name, async () => {
    const absolute = path.join(dir, name);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "before");
    const fixed = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(absolute, fixed, fixed);
    const before = await fs.stat(absolute);
    const hints: WatchDirty[] = [];
    const admitted = await root(dir);
    owner = watch(admitted, { scopes: [{ path: name, kind: "entry" }], onDirty: hint => { hints.push(hint); } });
    await owner.ready;
    hints.length = 0;
    await fs.writeFile(absolute, "edited");
    await fs.utimes(absolute, fixed, fixed);
    const after = await fs.stat(absolute);
    expect([after.size, after.mtimeMs, after.ino]).toEqual([before.size, before.mtimeMs, before.ino]);
    // Metadata reconciliation alone cannot account for this edit. Require a
    // relevant native hint, not an injected success or post-edit manual scan.
    await expect.poll(() => hints.some(hint => hint.changes === undefined
      ? hint.scopes.some(scope => scope.path === path.normalize(name))
      : hint.changes.some(change => change.path === path.normalize(name)))).toBe(true);
    await expect(admitted.readText(name)).resolves.toBe("edited");
    expect(owner.health().state).toBe("ready");
  });
}
