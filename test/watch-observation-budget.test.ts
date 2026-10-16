import fs, { Dir } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { root } from "../src/root.js";
import { watch, type WatchSubscription } from "../src/watch.js";
import { loadTestNative } from "./helpers/native-probe.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
const binding = loadTestNative("required-env");
const nodeRuntime = !process.versions.bun && !process.versions.deno;
let owner: WatchSubscription | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await owner?.close();
  owner = undefined;
  __resetFsSafeNativeConfigForTest();
});

it.skipIf(!binding?.observeDirectory)("bounds full path walks during repeated polling scans", async () => {
  configureFsSafeNative({ mode: "require" });
  const directory = await tempRoot("watch-observation-budget-");
  let directories = 1, files = 0;
  for (let branch = 0; branch < 8; branch++) {
    let parent = directory;
    for (let depth = 0; depth < 4; depth++) {
      parent = path.join(parent, `branch-${branch}-${depth}`);
      fs.mkdirSync(parent);
      directories++;
      for (let leaf = 0; leaf < 8; leaf++) {
        fs.writeFileSync(path.join(parent, `file-${leaf}`), "fixture");
        files++;
      }
    }
  }
  owner = watch(await root(directory), {
    mode: "poll", scopes: [{ path: "", kind: "tree" }],
    pollIntervalMs: 2_147_483_647, onInvalidate() {},
  });
  await owner.ready;
  const canonical = vi.spyOn(fs.realpathSync, "native");
  const metadata = vi.spyOn(fs, "lstatSync");
  const observed = vi.spyOn(binding!, "observeDirectory");
  for (let tick = 0; tick < 2; tick++) {
    canonical.mockClear(); metadata.mockClear(); observed.mockClear();
    await owner.reconcile();
    expect(owner.health()).toMatchObject({ state: "ready", mode: "poll", directories });
    // Full pathname admission is per directory; entry fences use the admitted
    // native observation instead of walking every path component again.
    expect(canonical.mock.calls.length).toBeLessThanOrEqual(directories * 10);
    expect(metadata.mock.calls.length).toBeLessThanOrEqual(files * 5 + directories * 20);
    expect(observed.mock.calls.length).toBeGreaterThan(files * 3);
  }
});

it.skipIf(process.platform === "win32" || !nodeRuntime || !binding?.observeDirectory)
  .each(["directory", "symlink", "ancestor", "root"] as const)("rejects a deep %s swap before inspecting its leaf", async swap => {
  configureFsSafeNative({ mode: "require" });
  const directory = await tempRoot("watch-observation-redirect-");
  const outside = await tempRoot("watch-observation-moved-");
  const ancestor = path.join(directory, "one");
  const child = path.join(ancestor, "two", "three");
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(child, "sentinel"), "fixture");
  const read = Dir.prototype.readSync;
  let swapped = false;
  vi.spyOn(Dir.prototype, "readSync").mockImplementation(function (this: Dir) {
    const entry = read.call(this);
    if (!swapped && this.path === child && entry !== null) {
      swapped = true;
      const moved = swap === "root" ? directory : swap === "ancestor" ? ancestor : child;
      fs.renameSync(moved, path.join(outside, "moved"));
      if (swap === "directory" || swap === "root") fs.mkdirSync(moved);
      else fs.symlinkSync(path.join(outside, "moved"), moved, "dir");
    }
    return entry;
  });
  const metadata = vi.spyOn(fs, "lstatSync");
  owner = watch(await root(directory), {
    mode: "poll", scopes: [{ path: "one", kind: "tree" }], onInvalidate() {},
  });
  if (swap === "root") await expect(owner.ready).rejects.toMatchObject({ code: "path-mismatch" });
  else await owner.ready;
  expect(swapped).toBe(true);
  expect(metadata.mock.calls.filter(([name]) => String(name) === path.join(child, "sentinel"))).toHaveLength(0);
  if (swap !== "root") expect(owner.health().failure).toBeUndefined();
});
