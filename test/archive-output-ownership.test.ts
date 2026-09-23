import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtractionDeadline } from "../src/archive-deadline.js";
import { prepareArchiveOutputPath, preparePrivateArchiveOutputPath } from "../src/archive-staging.js";
import { configureFsSafeNative, __resetFsSafeNativeConfigForTest } from "../src/native-config.js";
import { realpathSync } from "../src/realpath.js";
import { __setFsSafeTestHooksForTest } from "../src/test-hooks.js";
import { useRealTempDirs } from "./helpers/vitest.js";

const { tempRoot } = useRealTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  __setFsSafeTestHooksForTest();
  __resetFsSafeNativeConfigForTest();
});

const preparations = [
  { name: "public", prepare: prepareArchiveOutputPath },
  { name: "private", prepare: preparePrivateArchiveOutputPath },
];
const routes = [
  { name: "directory", relative: "entry", isDirectory: true, createsDirectory: true },
  { name: "nested file", relative: "entry/file", isDirectory: false, createsDirectory: true },
  { name: "direct file", relative: "file", isDirectory: false, createsDirectory: false },
];

it.each(preparations.flatMap(preparation => routes.map(route => ({ ...preparation, route }))))(
  "$name preparation retains $route.name containment ownership",
  async ({ prepare, route }) => {
    configureFsSafeNative({ mode: "off" });
    const destination = await tempRoot("fs-safe-archive-output-owner-");
    const output = path.join(destination, route.relative);
    const checkedPath = route.isDirectory ? output : path.dirname(output);
    let owned = false;
    let mutations = 0;
    let directoryReads = 0;
    const checks: boolean[] = [];
    const resolutions: boolean[] = [];
    const hooks: string[] = [];
    const deadline: ExtractionDeadline = {
      signal: new AbortController().signal,
      check() { checks.push(owned); },
      async ownDestinationMutation(run) {
        mutations++;
        owned = true;
        try { return await run(); }
        finally { owned = false; }
      },
      async waitForDestinationMutations() {},
      dispose() {},
    };
    const realpath = realpathSync.native;
    vi.spyOn(realpathSync, "native").mockImplementation((target) => {
      if (String(target) === checkedPath) resolutions.push(owned);
      return realpath(target);
    });
    __setFsSafeTestHooksForTest({ beforeArchiveOutputMutation(operation, target) {
      expect(operation).toBe("mkdir");
      expect(owned).toBe(false);
      hooks.push(target);
    } });

    await prepare({
      destinationDir: destination, destinationRealDir: destination,
      relPath: route.relative, outPath: output, originalPath: route.relative, deadline,
      get isDirectory() { directoryReads++; return directoryReads === 1 ? route.isDirectory : !route.isDirectory; },
    });

    expect(directoryReads).toBe(1);
    expect(mutations).toBe(route.createsDirectory ? 1 : 0);
    expect(hooks).toEqual(route.createsDirectory ? [checkedPath] : []);
    expect(resolutions.at(-1)).toBe(route.isDirectory);
    expect(checks.at(-1)).toBe(route.isDirectory);
    expect(owned).toBe(false);
    expect((await fs.stat(checkedPath)).isDirectory()).toBe(true);
  },
);
